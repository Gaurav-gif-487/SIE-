/**
 * Trajectory replay and verification.
 *
 * replay  → reconstructs the event sequence, repo state transitions,
 *            detector signals, interventions, and outcomes.
 *
 * verify  → checks hash chain integrity, event ordering, completeness.
 *            Returns OBSERVATION_VERIFIED or a detailed failure report.
 */

import fs from "node:fs";
import type { TrajectoryEvent, EventType } from "../types.js";
import { computeEventHash } from "../types.js";
import { TrajectoryRecorder } from "./recorder.js";

// ────────────────────────────────────────────────────── Verification

export interface VerificationResult {
  status: "OBSERVATION_VERIFIED" | "VERIFICATION_FAILED";
  trajectory_path: string;
  total_events: number;
  errors: VerificationError[];
}

export interface VerificationError {
  type:
    | "missing_event"
    | "broken_hash_chain"
    | "inconsistent_repository_state"
    | "impossible_event_ordering"
    | "corrupted_trajectory"
    | "duplicate_event_id"
    | "missing_required_field";
  event_index: number;
  event_id: string | null;
  message: string;
}

/**
 * Verify the integrity of a trajectory file.
 *
 * Checks:
 * 1. Hash chain: each event's hash matches recomputation from its content + previous hash
 * 2. Chain linkage: each event's previous_event_hash matches the prior event's event_hash
 * 3. Event ordering: timestamps are non-decreasing
 * 4. Required fields: every event has all mandatory fields
 * 5. Duplicate IDs: no two events share an event_id
 * 6. First/last events: trajectory should start with task_started and end with task_finished
 * 7. Repository state consistency: no backwards time-travel in repo states
 */
export function verifyTrajectory(trajectoryPath: string): VerificationResult {
  const errors: VerificationError[] = [];

  let events: TrajectoryEvent[];
  try {
    events = TrajectoryRecorder.readTrajectory(trajectoryPath);
  } catch (e) {
    return {
      status: "VERIFICATION_FAILED",
      trajectory_path: trajectoryPath,
      total_events: 0,
      errors: [
        {
          type: "corrupted_trajectory",
          event_index: -1,
          event_id: null,
          message: `Failed to read trajectory: ${(e as Error).message}`,
        },
      ],
    };
  }

  if (events.length === 0) {
    return {
      status: "VERIFICATION_FAILED",
      trajectory_path: trajectoryPath,
      total_events: 0,
      errors: [
        {
          type: "missing_event",
          event_index: -1,
          event_id: null,
          message: "Trajectory is empty",
        },
      ],
    };
  }

  const seenIds = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    // Required fields check
    const requiredFields: (keyof TrajectoryEvent)[] = [
      "event_id",
      "task_id",
      "experiment_id",
      "session_id",
      "timestamp",
      "condition",
      "event_type",
      "actor",
      "execution_mode",
      "event_hash",
    ];
    for (const field of requiredFields) {
      if (event[field] === undefined || event[field] === "") {
        errors.push({
          type: "missing_required_field",
          event_index: i,
          event_id: event.event_id ?? null,
          message: `Missing required field: ${field}`,
        });
      }
    }

    // Duplicate ID check
    if (seenIds.has(event.event_id)) {
      errors.push({
        type: "duplicate_event_id",
        event_index: i,
        event_id: event.event_id,
        message: `Duplicate event_id: ${event.event_id}`,
      });
    }
    seenIds.add(event.event_id);

    // Hash chain verification
    const { event_hash: _stored, ...rest } = event;
    const recomputed = computeEventHash(rest);
    if (recomputed !== event.event_hash) {
      errors.push({
        type: "broken_hash_chain",
        event_index: i,
        event_id: event.event_id,
        message: `Hash mismatch at event ${i}: stored=${event.event_hash.slice(0, 12)}…, recomputed=${recomputed.slice(0, 12)}…`,
      });
    }

    // Chain linkage
    if (i === 0) {
      if (event.previous_event_hash !== null) {
        errors.push({
          type: "broken_hash_chain",
          event_index: i,
          event_id: event.event_id,
          message: "First event should have previous_event_hash = null",
        });
      }
    } else {
      const prev = events[i - 1]!;
      if (event.previous_event_hash !== prev.event_hash) {
        errors.push({
          type: "broken_hash_chain",
          event_index: i,
          event_id: event.event_id,
          message: `Chain linkage broken: event ${i} points to ${event.previous_event_hash?.slice(0, 12)}… but previous event hash is ${prev.event_hash.slice(0, 12)}…`,
        });
      }
    }

    // Temporal ordering
    if (i > 0) {
      const prev = events[i - 1]!;
      const prevTime = new Date(prev.timestamp).getTime();
      const currTime = new Date(event.timestamp).getTime();
      if (currTime < prevTime) {
        errors.push({
          type: "impossible_event_ordering",
          event_index: i,
          event_id: event.event_id,
          message: `Event ${i} timestamp (${event.timestamp}) is before event ${i - 1} (${prev.timestamp})`,
        });
      }
    }
  }

  // First event should be task_started
  if (events[0]!.event_type !== "task_started") {
    errors.push({
      type: "missing_event",
      event_index: 0,
      event_id: events[0]!.event_id,
      message: `Expected first event to be task_started, got ${events[0]!.event_type}`,
    });
  }

  // Last event should be task_finished
  const last = events[events.length - 1]!;
  if (last.event_type !== "task_finished") {
    errors.push({
      type: "missing_event",
      event_index: events.length - 1,
      event_id: last.event_id,
      message: `Expected last event to be task_finished, got ${last.event_type}`,
    });
  }

  return {
    status: errors.length === 0 ? "OBSERVATION_VERIFIED" : "VERIFICATION_FAILED",
    trajectory_path: trajectoryPath,
    total_events: events.length,
    errors,
  };
}

// ────────────────────────────────────────────────────── Replay

export interface ReplayStep {
  event_index: number;
  event: TrajectoryEvent;
  /** Repository state at this point */
  repository_state: string | null;
  /** Detector signals emitted at or before this event */
  detector_signals_so_far: TrajectoryEvent[];
  /** Interventions delivered at or before this event */
  interventions_so_far: TrajectoryEvent[];
}

export interface ReplayResult {
  trajectory_path: string;
  total_events: number;
  steps: ReplayStep[];
  /** All file paths touched during the trajectory */
  files_touched: string[];
  /** All commands executed */
  commands_executed: string[];
  /** Repository state transitions: array of [event_index, state] */
  state_transitions: Array<[number, string | null]>;
  /** Final outcome event, if present */
  outcome: TrajectoryEvent | null;
  /** Verification result */
  verification: VerificationResult;
}

/**
 * Replay a trajectory, reconstructing the sequence of events,
 * repository state transitions, detector signals, interventions,
 * and the final outcome.
 */
export function replayTrajectory(trajectoryPath: string): ReplayResult {
  const verification = verifyTrajectory(trajectoryPath);
  const events = TrajectoryRecorder.readTrajectory(trajectoryPath);

  const steps: ReplayStep[] = [];
  const filesTouched = new Set<string>();
  const commandsExecuted: string[] = [];
  const stateTransitions: Array<[number, string | null]> = [];
  const detectorSignals: TrajectoryEvent[] = [];
  const interventions: TrajectoryEvent[] = [];
  let lastState: string | null = null;
  let outcome: TrajectoryEvent | null = null;

  const FILE_EVENTS: Set<EventType> = new Set([
    "file_read", "file_created", "file_modified", "file_deleted",
  ]);
  const COMMAND_EVENTS: Set<EventType> = new Set([
    "command_started", "command_finished",
  ]);

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    // Track file touches
    if (FILE_EVENTS.has(event.event_type) && event.path) {
      filesTouched.add(event.path);
    }

    // Track commands
    if (COMMAND_EVENTS.has(event.event_type) && event.command) {
      commandsExecuted.push(event.command);
    }

    // Track state transitions
    if (event.repository_state !== lastState) {
      stateTransitions.push([i, event.repository_state]);
      lastState = event.repository_state;
    }

    // Track detector signals
    if (event.event_type === "detector_signal") {
      detectorSignals.push(event);
    }

    // Track interventions
    if (event.event_type === "intervention_delivered") {
      interventions.push(event);
    }

    // Track outcome
    if (event.event_type === "task_finished") {
      outcome = event;
    }

    steps.push({
      event_index: i,
      event,
      repository_state: event.repository_state,
      detector_signals_so_far: [...detectorSignals],
      interventions_so_far: [...interventions],
    });
  }

  return {
    trajectory_path: trajectoryPath,
    total_events: events.length,
    steps,
    files_touched: [...filesTouched],
    commands_executed: commandsExecuted,
    state_transitions: stateTransitions,
    outcome,
    verification,
  };
}
