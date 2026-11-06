/**
 * Agent Mirror Experimental Intelligence Lab — Core Types
 *
 * Every type in this file is the single source of truth for the lab.
 * No module may define its own parallel version of these types.
 */

import crypto from "node:crypto";

// ──────────────────────────────────────────────────────────────── Data Labels

/** Every piece of data must declare its provenance. */
export type DataLabel = "REAL" | "SYNTHETIC" | "HUMAN_LABELED" | "SIMULATED";

/** Execution mode of the agent adapter that produced the data. */
export type ExecutionMode = "real" | "synthetic";

// ──────────────────────────────────────────────────────────── Experiment Core

export type ExperimentCondition = "control" | "treatment";

export interface ExperimentConfig {
  experiment_id: string;
  name: string;
  created_at: string;
  task_ids: string[];
  /** 'control' | 'treatment' | 'randomized' */
  condition_mode: "control" | "treatment" | "randomized";
  control_rate: number;
  /** Maps task_id → assigned condition (populated at run time) */
  assignments: Record<string, ExperimentCondition>;
  agent_adapter: string;
  execution_mode: ExecutionMode;
  data_label: DataLabel;
  enable_interventions: boolean;
}

export interface ExperimentResult {
  experiment_id: string;
  name: string;
  completed_at: string;
  task_results: TaskResult[];
  data_label: DataLabel;
  execution_mode: ExecutionMode;
}

// ──────────────────────────────────────────────────────── Benchmark Task Def

export interface BenchmarkTask {
  id: string;
  description: string;
  repository: string;
  expected_tests: string[];
  difficulty: "easy" | "medium" | "hard";
  category:
    | "bug_fix"
    | "feature_addition"
    | "test_repair"
    | "refactor"
    | "dependency_change"
    | "api_modification"
    | "duplicate_temptation"
    | "scope_expansion"
    | "retry_prone"
    | "test_blind";
  /** Files the task is expected to touch */
  relevant_files: string[];
}

// ─────────────────────────────────────────────────────── Task Outcome / Result

export interface TaskOutcome {
  task_success: boolean;
  tests_passed: number;
  tests_failed: number;
  time_to_completion_ms: number;
  total_commands: number;
  retry_count: number;
  files_changed: number;
  loc_changed: number;
  duplicate_loc: number;
  build_status: "success" | "failure" | "skipped";
  lint_status: "success" | "failure" | "skipped";
  cost_if_available: number | null;
  /** How was this outcome determined? */
  evaluation_method: "automated" | "human_labeled";
}

export interface TaskResult {
  task_id: string;
  experiment_id: string;
  session_id: string;
  condition: ExperimentCondition;
  execution_mode: ExecutionMode;
  data_label: DataLabel;
  agent_adapter: string;
  model_provider: string | null;
  model_name: string | null;
  repository_initial_hash: string | null;
  repository_final_hash: string | null;
  started_at: string;
  finished_at: string;
  outcome: TaskOutcome;
  trajectory_path: string;
  detector_signals: DetectorSignal[];
  interventions: InterventionRecord[];
}

// ──────────────────────────────────────────────────── Trajectory Event Schema

/**
 * All possible event types in a trajectory.
 * This is the vocabulary of observable agent behavior.
 */
export type EventType =
  | "task_started"
  | "agent_message"
  | "tool_requested"
  | "tool_executed"
  | "tool_failed"
  | "file_read"
  | "file_created"
  | "file_modified"
  | "file_deleted"
  | "command_started"
  | "command_finished"
  | "test_started"
  | "test_finished"
  | "build_started"
  | "build_finished"
  | "git_status"
  | "git_diff"
  | "commit_created"
  | "detector_signal"
  | "intervention_proposed"
  | "intervention_delivered"
  | "agent_response"
  | "task_finished";

/**
 * Who caused this event.
 */
export type EventActor = "agent" | "system" | "detector" | "intervention_engine" | "user";

/**
 * Immutable trajectory event.
 * Once recorded, the hash chain prevents undetected modification.
 */
export interface TrajectoryEvent {
  event_id: string;
  task_id: string;
  experiment_id: string;
  session_id: string;
  timestamp: string;
  condition: ExperimentCondition;
  event_type: EventType;
  actor: EventActor;
  execution_mode: ExecutionMode;
  /** Git commit hash at the time of the event (null if not in a git repo) */
  repository_state: string | null;
  /** File path, if the event concerns a specific file */
  path?: string;
  /** Shell command, if the event is a command execution */
  command?: string;
  /** Arbitrary structured payload (event-type-specific data) */
  payload?: Record<string, unknown>;
  /** Hash of the previous event in this trajectory (null for the first event) */
  previous_event_hash: string | null;
  /** SHA-256 hash of this event's content + previous_event_hash */
  event_hash: string;
}

// ────────────────────────────────────────────────────────── Detector Signals

export type DetectorSignalType =
  | "retry_loop"
  | "test_blindness"
  | "scope_expansion"
  | "duplicate_behavior"
  | "repeated_failure";

export type SignalSeverity = "low" | "medium" | "high";

export interface DetectorSignal {
  signal: DetectorSignalType;
  severity: SignalSeverity;
  /** 0..1 */
  confidence: number;
  /** Event IDs that constitute the evidence */
  evidence: string[];
  detected_at: string;
  detector_version: string;
}

// ────────────────────────────────────────────────── Intervention

export type InterventionPolicy =
  | "WARN"
  | "SUGGEST_TEST"
  | "SUGGEST_SCOPE_REVIEW"
  | "SUGGEST_STOP_RETRYING";

export interface InterventionRecord {
  intervention_id: string;
  signal: DetectorSignalType;
  signal_confidence: number;
  policy: InterventionPolicy;
  message: string;
  timestamp: string;
  agent_response: string | null;
  accepted: boolean | null;
  /** Was the intervention actually delivered to the agent? */
  delivered: boolean;
}

// ────────────────────────────────────────────────── Intelligence Promotion

export type PromotionState =
  | "OBSERVED"
  | "DETECTED"
  | "PREDICTIVE"
  | "INTERVENTION_TESTED"
  | "EFFECTIVE"
  | "AUTOMATABLE";

export interface PromotionRecord {
  signal: DetectorSignalType;
  current_state: PromotionState;
  promotion_history: Array<{
    from: PromotionState;
    to: PromotionState;
    criteria_met: string;
    evidence_summary: string;
    promoted_at: string;
  }>;
}

// ────────────────────────────────────────────────── Repository Observation

export interface RepositoryObservation {
  initial_commit: string | null;
  final_commit: string | null;
  git_diff: string | null;
  files_changed: string[];
  files_created: string[];
  files_deleted: string[];
  files_read: string[];
  lines_added: number;
  lines_removed: number;
  test_files_changed: string[];
  commands_executed: string[];
  test_results: TestRunResult | null;
  build_results: BuildResult | null;
  lint_results: LintResult | null;
}

export interface TestRunResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration_ms: number;
  details: Array<{
    name: string;
    status: "passed" | "failed" | "skipped";
    duration_ms: number;
    error?: string;
  }>;
}

export interface BuildResult {
  status: "success" | "failure";
  duration_ms: number;
  errors: string[];
}

export interface LintResult {
  status: "success" | "failure";
  warnings: number;
  errors: number;
  details: string[];
}

// ────────────────────────────────────────────────── Redaction Config

export interface RedactionConfig {
  patterns: RedactionPattern[];
  /** If true, environment variables are redacted from all payloads */
  redact_env_vars: boolean;
}

export interface RedactionPattern {
  name: string;
  /** Regex pattern to match */
  pattern: string;
  /** Replacement text */
  replacement: string;
}

// ────────────────────────────────────────────────── Prediction Model

export interface PredictionResult {
  failure_probability: number;
  model_version: string;
  features: Record<string, number>;
  prediction: "likely_success" | "likely_failure";
  calibration_status: "calibrated" | "uncalibrated" | "insufficient_data";
}

// ────────────────────────────────────────────────── Sandbox

export type SandboxMode = "local" | "docker";

export interface SandboxConfig {
  mode: SandboxMode;
  /** If true, allows executing agent commands directly on the host. DANGEROUS. */
  unsafe_mode: boolean;
  /** Base directory for sandbox workspaces */
  workspace_root: string;
  /** Archive completed workspaces? */
  archive: boolean;
}

// ────────────────────────────────────────────────── Utility: Event hashing

/**
 * Compute the SHA-256 hash of a trajectory event.
 * The hash covers all fields EXCEPT event_hash itself.
 */
export function computeEventHash(event: Omit<TrajectoryEvent, "event_hash">): string {
  const content = JSON.stringify({
    event_id: event.event_id,
    task_id: event.task_id,
    experiment_id: event.experiment_id,
    session_id: event.session_id,
    timestamp: event.timestamp,
    condition: event.condition,
    event_type: event.event_type,
    actor: event.actor,
    execution_mode: event.execution_mode,
    repository_state: event.repository_state,
    path: event.path,
    command: event.command,
    payload: event.payload,
    previous_event_hash: event.previous_event_hash,
  });
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Generate a unique event ID.
 */
export function generateEventId(): string {
  return `evt_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Generate a unique session ID.
 */
export function generateSessionId(): string {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Generate a unique experiment ID.
 */
export function generateExperimentId(): string {
  return `exp_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Generate a unique intervention ID.
 */
export function generateInterventionId(): string {
  return `int_${crypto.randomUUID().replace(/-/g, "")}`;
}
