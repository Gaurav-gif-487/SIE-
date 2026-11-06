/**
 * Immutable trajectory recorder.
 *
 * Writes events as append-only JSONL to:
 *   data/trajectories/<experiment>/<task>.jsonl
 *
 * Each event is hash-chained: SHA-256(content + previous_event_hash).
 * Tampering with any event breaks the chain for all subsequent events.
 *
 * Secrets are redacted before recording via the Redactor.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  TrajectoryEvent,
  EventType,
  EventActor,
  ExperimentCondition,
  ExecutionMode,
} from "../types.js";
import {
  computeEventHash,
  generateEventId,
} from "../types.js";
import { Redactor } from "./redactor.js";
import type { RedactionConfig } from "../types.js";

export interface RecorderOptions {
  /** Base directory for trajectory storage. Default: data/trajectories */
  baseDir: string;
  experiment_id: string;
  task_id: string;
  session_id: string;
  condition: ExperimentCondition;
  execution_mode: ExecutionMode;
  /** Redaction configuration. If omitted, uses defaults. */
  redaction?: Partial<RedactionConfig>;
}

export class TrajectoryRecorder {
  private readonly filePath: string;
  private readonly redactor: Redactor;
  private readonly experiment_id: string;
  private readonly task_id: string;
  private readonly session_id: string;
  private readonly condition: ExperimentCondition;
  private readonly execution_mode: ExecutionMode;
  private previousHash: string | null = null;
  private eventCount = 0;
  private closed = false;
  private fd: number;

  constructor(options: RecorderOptions) {
    this.experiment_id = options.experiment_id;
    this.task_id = options.task_id;
    this.session_id = options.session_id;
    this.condition = options.condition;
    this.execution_mode = options.execution_mode;
    this.redactor = new Redactor(options.redaction);

    const dir = path.join(options.baseDir, options.experiment_id);
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `${options.task_id}.jsonl`);

    // Open file for append. Each event is one line.
    this.fd = fs.openSync(this.filePath, "a");
  }

  /** Path to the trajectory file. */
  get trajectoryPath(): string {
    return this.filePath;
  }

  /** Number of events recorded so far. */
  get count(): number {
    return this.eventCount;
  }

  /** Hash of the last recorded event (null if no events yet). */
  get lastHash(): string | null {
    return this.previousHash;
  }

  /**
   * Record a trajectory event.
   *
   * @param eventType - The type of event
   * @param actor - Who caused this event
   * @param fields - Additional event fields (path, command, payload, repository_state)
   * @returns The recorded event with computed hash
   */
  record(
    eventType: EventType,
    actor: EventActor,
    fields?: {
      repository_state?: string | null;
      path?: string;
      command?: string;
      payload?: Record<string, unknown>;
    },
  ): TrajectoryEvent {
    if (this.closed) {
      throw new Error("TrajectoryRecorder is closed; cannot record new events");
    }

    // Redact payload secrets
    const redactedPayload = fields?.payload
      ? this.redactor.redactPayload(fields.payload)
      : undefined;

    // Redact command string
    const redactedCommand = fields?.command
      ? this.redactor.redactString(fields.command)
      : undefined;

    const eventWithoutHash: Omit<TrajectoryEvent, "event_hash"> = {
      event_id: generateEventId(),
      task_id: this.task_id,
      experiment_id: this.experiment_id,
      session_id: this.session_id,
      timestamp: new Date().toISOString(),
      condition: this.condition,
      event_type: eventType,
      actor,
      execution_mode: this.execution_mode,
      repository_state: fields?.repository_state ?? null,
      path: fields?.path,
      command: redactedCommand,
      payload: redactedPayload,
      previous_event_hash: this.previousHash,
    };

    const event_hash = computeEventHash(eventWithoutHash);
    const event: TrajectoryEvent = { ...eventWithoutHash, event_hash };

    // Append to JSONL
    const line = JSON.stringify(event) + "\n";
    fs.writeSync(this.fd, line);

    this.previousHash = event_hash;
    this.eventCount++;

    return event;
  }

  /**
   * Close the recorder. Flushes and closes the file descriptor.
   * No more events can be recorded after this.
   */
  close(): void {
    if (!this.closed) {
      fs.closeSync(this.fd);
      this.closed = true;
    }
  }

  /**
   * Read all events from the trajectory file.
   * Useful for post-hoc analysis.
   */
  static readTrajectory(filePath: string): TrajectoryEvent[] {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Trajectory file not found: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as TrajectoryEvent);
  }
}
