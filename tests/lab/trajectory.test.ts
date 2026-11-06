/**
 * Phase 1 tests: trajectory infrastructure.
 *
 * Covers:
 * - Event creation with all required fields
 * - Hash chain correctness (tamper detection)
 * - JSONL append-only storage
 * - Replay reconstruction
 * - Verification pass/fail
 * - Secret redaction
 * - Synthetic/real labeling
 * - Mock agent end-to-end
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeEventHash,
  generateEventId,
  generateSessionId,
  generateExperimentId,
} from "../../src/lab/types.js";
import type { TrajectoryEvent } from "../../src/lab/types.js";
import { TrajectoryRecorder } from "../../src/lab/trajectory/recorder.js";
import { verifyTrajectory, replayTrajectory } from "../../src/lab/trajectory/replay.js";
import { Redactor } from "../../src/lab/trajectory/redactor.js";
import { MockAgentAdapter } from "../../src/lab/adapters/mock-agent.js";
import type { BenchmarkTask } from "../../src/lab/types.js";

// ──── Test helpers

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mirror-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const SAMPLE_TASK: BenchmarkTask = {
  id: "test-task-001",
  description: "Fix the off-by-one error in arraySum",
  repository: "fixtures/bug-fix-off-by-one",
  expected_tests: ["arraySum.test.ts"],
  difficulty: "easy",
  category: "bug_fix",
  relevant_files: ["src/math.ts", "tests/math.test.ts"],
};

// ──── Event ID / Hash generation

describe("types", () => {
  it("generates unique event IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateEventId());
    expect(ids.size).toBe(100);
  });

  it("generates IDs with correct prefixes", () => {
    expect(generateEventId()).toMatch(/^evt_/);
    expect(generateSessionId()).toMatch(/^ses_/);
    expect(generateExperimentId()).toMatch(/^exp_/);
  });

  it("computes deterministic event hash", () => {
    const event: Omit<TrajectoryEvent, "event_hash"> = {
      event_id: "evt_abc123",
      task_id: "task_001",
      experiment_id: "exp_001",
      session_id: "ses_001",
      timestamp: "2026-01-01T00:00:00.000Z",
      condition: "control",
      event_type: "task_started",
      actor: "system",
      execution_mode: "synthetic",
      repository_state: null,
      previous_event_hash: null,
    };
    const h1 = computeEventHash(event);
    const h2 = computeEventHash(event);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hash changes when any field changes", () => {
    const base: Omit<TrajectoryEvent, "event_hash"> = {
      event_id: "evt_abc123",
      task_id: "task_001",
      experiment_id: "exp_001",
      session_id: "ses_001",
      timestamp: "2026-01-01T00:00:00.000Z",
      condition: "control",
      event_type: "task_started",
      actor: "system",
      execution_mode: "synthetic",
      repository_state: null,
      previous_event_hash: null,
    };
    const h1 = computeEventHash(base);
    const h2 = computeEventHash({ ...base, task_id: "task_002" });
    const h3 = computeEventHash({ ...base, event_type: "task_finished" });
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h2).not.toBe(h3);
  });
});

// ──── TrajectoryRecorder

describe("TrajectoryRecorder", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("creates trajectory JSONL file", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "control",
      execution_mode: "synthetic",
    });

    rec.record("task_started", "system");
    rec.record("task_finished", "system");
    rec.close();

    expect(fs.existsSync(rec.trajectoryPath)).toBe(true);
    const lines = fs.readFileSync(rec.trajectoryPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  it("builds correct hash chain", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "control",
      execution_mode: "synthetic",
    });

    const e1 = rec.record("task_started", "system");
    const e2 = rec.record("agent_message", "agent", { payload: { content: "hello" } });
    const e3 = rec.record("task_finished", "system");
    rec.close();

    // First event has no previous hash
    expect(e1.previous_event_hash).toBeNull();
    // Second event links to first
    expect(e2.previous_event_hash).toBe(e1.event_hash);
    // Third event links to second
    expect(e3.previous_event_hash).toBe(e2.event_hash);

    // Hashes are valid SHA-256
    expect(e1.event_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(e2.event_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(e3.event_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records all required fields", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "treatment",
      execution_mode: "synthetic",
    });

    const event = rec.record("file_modified", "agent", {
      path: "src/foo.ts",
      repository_state: "abc123",
      payload: { diff: "+line1" },
    });
    rec.close();

    expect(event.event_id).toMatch(/^evt_/);
    expect(event.task_id).toBe("task_001");
    expect(event.experiment_id).toBe("exp_test");
    expect(event.session_id).toBe("ses_001");
    expect(event.condition).toBe("treatment");
    expect(event.event_type).toBe("file_modified");
    expect(event.actor).toBe("agent");
    expect(event.execution_mode).toBe("synthetic");
    expect(event.repository_state).toBe("abc123");
    expect(event.path).toBe("src/foo.ts");
    expect(event.payload).toEqual({ diff: "+line1" });
    expect(event.timestamp).toBeTruthy();
    expect(event.event_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects recording after close", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "control",
      execution_mode: "synthetic",
    });
    rec.record("task_started", "system");
    rec.close();

    expect(() => rec.record("task_finished", "system")).toThrow("closed");
  });

  it("redacts secrets in payloads", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "control",
      execution_mode: "synthetic",
    });

    const event = rec.record("agent_message", "agent", {
      payload: {
        password: "super_secret_123",
        content: "Using api_key=sk-abcdefghijklmnopqr",
      },
    });
    rec.close();

    // Password field should be redacted
    expect((event.payload as Record<string, unknown>)["password"]).toBe("[REDACTED]");
    // API key in content should be redacted
    const content = (event.payload as Record<string, unknown>)["content"] as string;
    expect(content).not.toContain("sk-abcdefghijklmnopqr");
  });

  it("redacts secrets in commands", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "control",
      execution_mode: "synthetic",
    });

    const event = rec.record("command_started", "agent", {
      command: "curl -H 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9' https://api.example.com",
    });
    rec.close();

    expect(event.command).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("reads back trajectory correctly", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "control",
      execution_mode: "synthetic",
    });

    rec.record("task_started", "system");
    rec.record("file_read", "agent", { path: "src/a.ts" });
    rec.record("file_modified", "agent", { path: "src/a.ts" });
    rec.record("test_started", "agent", { command: "npm test" });
    rec.record("test_finished", "system", { payload: { passed: 1, failed: 0 } });
    rec.record("task_finished", "system");
    rec.close();

    const events = TrajectoryRecorder.readTrajectory(rec.trajectoryPath);
    expect(events.length).toBe(6);
    expect(events[0]!.event_type).toBe("task_started");
    expect(events[5]!.event_type).toBe("task_finished");
  });
});

// ──── Verification

describe("verifyTrajectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("returns OBSERVATION_VERIFIED for valid trajectory", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "control",
      execution_mode: "synthetic",
    });
    rec.record("task_started", "system");
    rec.record("file_read", "agent", { path: "src/a.ts" });
    rec.record("task_finished", "system");
    rec.close();

    const result = verifyTrajectory(rec.trajectoryPath);
    expect(result.status).toBe("OBSERVATION_VERIFIED");
    expect(result.total_events).toBe(3);
    expect(result.errors.length).toBe(0);
  });

  it("detects tampered event (broken hash)", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "control",
      execution_mode: "synthetic",
    });
    rec.record("task_started", "system");
    rec.record("file_read", "agent", { path: "src/a.ts" });
    rec.record("task_finished", "system");
    rec.close();

    // Tamper with the JSONL file: modify event 1's payload
    const lines = fs.readFileSync(rec.trajectoryPath, "utf8").trim().split("\n");
    const event1 = JSON.parse(lines[1]!) as TrajectoryEvent;
    event1.path = "src/TAMPERED.ts";
    lines[1] = JSON.stringify(event1);
    fs.writeFileSync(rec.trajectoryPath, lines.join("\n") + "\n");

    const result = verifyTrajectory(rec.trajectoryPath);
    expect(result.status).toBe("VERIFICATION_FAILED");
    expect(result.errors.some((e) => e.type === "broken_hash_chain")).toBe(true);
  });

  it("detects missing task_started", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "control",
      execution_mode: "synthetic",
    });
    rec.record("file_read", "agent", { path: "src/a.ts" });
    rec.record("task_finished", "system");
    rec.close();

    const result = verifyTrajectory(rec.trajectoryPath);
    expect(result.status).toBe("VERIFICATION_FAILED");
    expect(result.errors.some((e) => e.message.includes("task_started"))).toBe(true);
  });

  it("detects empty trajectory", () => {
    const filePath = path.join(dir, "empty.jsonl");
    fs.writeFileSync(filePath, "");
    const result = verifyTrajectory(filePath);
    expect(result.status).toBe("VERIFICATION_FAILED");
    expect(result.errors.some((e) => e.message.includes("empty"))).toBe(true);
  });

  it("detects missing trajectory file", () => {
    const result = verifyTrajectory(path.join(dir, "nonexistent.jsonl"));
    expect(result.status).toBe("VERIFICATION_FAILED");
    expect(result.errors[0]!.type).toBe("corrupted_trajectory");
  });
});

// ──── Replay

describe("replayTrajectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("reconstructs event sequence and file touches", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "control",
      execution_mode: "synthetic",
    });
    rec.record("task_started", "system");
    rec.record("file_read", "agent", { path: "src/a.ts" });
    rec.record("file_modified", "agent", { path: "src/a.ts", payload: { diff: "+fix" } });
    rec.record("file_created", "agent", { path: "src/b.ts" });
    rec.record("command_started", "agent", { command: "npm test" });
    rec.record("command_finished", "system", { command: "npm test", payload: { exit_code: 0 } });
    rec.record("task_finished", "system", { payload: { success: true } });
    rec.close();

    const replay = replayTrajectory(rec.trajectoryPath);
    expect(replay.total_events).toBe(7);
    expect(replay.files_touched).toContain("src/a.ts");
    expect(replay.files_touched).toContain("src/b.ts");
    expect(replay.commands_executed).toContain("npm test");
    expect(replay.outcome).not.toBeNull();
    expect(replay.outcome!.event_type).toBe("task_finished");
    expect(replay.verification.status).toBe("OBSERVATION_VERIFIED");
  });

  it("tracks detector signals and interventions", () => {
    const rec = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: "exp_test",
      task_id: "task_001",
      session_id: "ses_001",
      condition: "treatment",
      execution_mode: "synthetic",
    });
    rec.record("task_started", "system");
    rec.record("file_modified", "agent", { path: "src/a.ts" });
    rec.record("detector_signal", "detector", {
      payload: { signal: "retry_loop", confidence: 0.87 },
    });
    rec.record("intervention_delivered", "intervention_engine", {
      payload: { policy: "WARN", message: "You seem to be retrying" },
    });
    rec.record("agent_response", "agent", {
      payload: { accepted: true },
    });
    rec.record("task_finished", "system");
    rec.close();

    const replay = replayTrajectory(rec.trajectoryPath);
    // At the last step, both signals and interventions should be visible
    const lastStep = replay.steps[replay.steps.length - 1]!;
    expect(lastStep.detector_signals_so_far.length).toBe(1);
    expect(lastStep.interventions_so_far.length).toBe(1);
  });
});

// ──── Redactor

describe("Redactor", () => {
  it("redacts API keys in strings", () => {
    const r = new Redactor();
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def';
    const result = r.redactString(input);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts GitHub tokens", () => {
    const r = new Redactor();
    const input = "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl";
    const result = r.redactString(input);
    expect(result).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });

  it("redacts AWS keys", () => {
    const r = new Redactor();
    const input = "aws_key=AKIAIOSFODNN7EXAMPLE";
    const result = r.redactString(input);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts password fields in payloads", () => {
    const r = new Redactor();
    const payload = { password: "my_secret_pw", name: "John" };
    const result = r.redactPayload(payload);
    expect(result.password).toBe("[REDACTED]");
    expect(result.name).toBe("John");
  });

  it("deep-redacts nested objects", () => {
    const r = new Redactor();
    const payload = {
      config: {
        auth: {
          api_key: "sk-1234567890abcdef",
        },
      },
      name: "safe",
    };
    const result = r.redactPayload(payload);
    expect(result.config.auth.api_key).toBe("[REDACTED]");
    expect(result.name).toBe("safe");
  });

  it("redacts arrays of strings", () => {
    const r = new Redactor();
    const arr = ["safe", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl"];
    const result = r.redactPayload(arr);
    expect(result[0]).toBe("safe");
    expect(result[1]).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });

  it("handles null and undefined gracefully", () => {
    const r = new Redactor();
    expect(r.redactPayload(null)).toBeNull();
    expect(r.redactPayload(undefined)).toBeUndefined();
    expect(r.redactPayload(42)).toBe(42);
    expect(r.redactPayload(true)).toBe(true);
  });
});

// ──── Mock Agent

describe("MockAgentAdapter", () => {
  it("always reports execution_mode = synthetic", () => {
    const agent = new MockAgentAdapter();
    expect(agent.executionMode).toBe("synthetic");
    expect(agent.getSessionMetadata().execution_mode).toBe("synthetic");
  });

  it("competent profile: reads, modifies, tests, succeeds", async () => {
    const agent = new MockAgentAdapter({ profile: "competent", stepDelay: 0 });
    const events: Array<Omit<TrajectoryEvent, "event_id" | "event_hash" | "previous_event_hash" | "experiment_id" | "condition">> = [];

    const result = await agent.executeTask(SAMPLE_TASK, "/tmp/workspace", (event) => {
      events.push(event);
    });

    expect(result.success).toBe(true);
    expect(result.session_id).toMatch(/^ses_/);
    expect(result.test_runs).toBe(1);

    // Check event types emitted
    const types = events.map((e) => e.event_type);
    expect(types[0]).toBe("task_started");
    expect(types[types.length - 1]).toBe("task_finished");
    expect(types).toContain("file_read");
    expect(types).toContain("file_modified");
    expect(types).toContain("test_started");
    expect(types).toContain("test_finished");

    // All events labeled synthetic
    for (const e of events) {
      expect(e.execution_mode).toBe("synthetic");
    }
  });

  it("retry-prone profile: retries before succeeding", async () => {
    const agent = new MockAgentAdapter({ profile: "retry-prone", stepDelay: 0 });
    const events: Array<Omit<TrajectoryEvent, "event_id" | "event_hash" | "previous_event_hash" | "experiment_id" | "condition">> = [];

    const result = await agent.executeTask(SAMPLE_TASK, "/tmp/workspace", (event) => {
      events.push(event);
    });

    expect(result.success).toBe(true);
    expect(result.retry_count).toBeGreaterThan(0);

    // Should have multiple test_finished events with some failures
    const testResults = events.filter((e) => e.event_type === "test_finished");
    expect(testResults.length).toBeGreaterThan(1);
    const failures = testResults.filter((e) => !(e.payload as Record<string, unknown>)?.["success"]);
    expect(failures.length).toBeGreaterThan(0);
  });

  it("test-blind profile: modifies code, never tests", async () => {
    const agent = new MockAgentAdapter({ profile: "test-blind", stepDelay: 0 });
    const events: Array<Omit<TrajectoryEvent, "event_id" | "event_hash" | "previous_event_hash" | "experiment_id" | "condition">> = [];

    const result = await agent.executeTask(SAMPLE_TASK, "/tmp/workspace", (event) => {
      events.push(event);
    });

    expect(result.success).toBe(true);
    expect(result.test_runs).toBe(0);

    const types = events.map((e) => e.event_type);
    expect(types).toContain("file_modified");
    expect(types).not.toContain("test_started");
    expect(types).not.toContain("test_finished");
  });

  it("scope-expanding profile: modifies extra files", async () => {
    const agent = new MockAgentAdapter({ profile: "scope-expanding", stepDelay: 0 });
    const events: Array<Omit<TrajectoryEvent, "event_id" | "event_hash" | "previous_event_hash" | "experiment_id" | "condition">> = [];

    const result = await agent.executeTask(SAMPLE_TASK, "/tmp/workspace", (event) => {
      events.push(event);
    });

    expect(result.success).toBe(true);
    expect(result.files_changed.length).toBeGreaterThan(SAMPLE_TASK.relevant_files.length);
  }, { retry: 0 });

  it("failing profile: fails task", async () => {
    const agent = new MockAgentAdapter({ profile: "failing", stepDelay: 0 });
    const events: Array<Omit<TrajectoryEvent, "event_id" | "event_hash" | "previous_event_hash" | "experiment_id" | "condition">> = [];

    const result = await agent.executeTask(SAMPLE_TASK, "/tmp/workspace", (event) => {
      events.push(event);
    });

    expect(result.success).toBe(false);
  });

  it("sendMessage returns synthetic label", async () => {
    const agent = new MockAgentAdapter({ stepDelay: 0 });
    const msg = await agent.sendMessage("You are retrying too many times");
    expect(msg.role).toBe("assistant");
    expect(msg.content).toContain("[SYNTHETIC]");
  });

  it("terminate is idempotent", async () => {
    const agent = new MockAgentAdapter({ stepDelay: 0 });
    await agent.terminate();
    await agent.terminate(); // should not throw
  });
});

// ──── End-to-end: Mock agent → Recorder → Verify → Replay

describe("Phase 1 end-to-end", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("synthetic task → mock agent → trajectory → verify → replay", async () => {
    const experimentId = "exp_e2e_001";
    const taskId = SAMPLE_TASK.id;
    const sessionId = generateSessionId();

    // 1. Create recorder
    const recorder = new TrajectoryRecorder({
      baseDir: dir,
      experiment_id: experimentId,
      task_id: taskId,
      session_id: sessionId,
      condition: "control",
      execution_mode: "synthetic",
    });

    // 2. Create mock agent
    const agent = new MockAgentAdapter({ profile: "competent", stepDelay: 0 });

    // 3. Execute task, routing events through recorder
    const result = await agent.executeTask(
      SAMPLE_TASK,
      "/tmp/workspace",
      (partialEvent) => {
        recorder.record(partialEvent.event_type, partialEvent.actor, {
          repository_state: partialEvent.repository_state,
          path: partialEvent.path,
          command: partialEvent.command,
          payload: partialEvent.payload as Record<string, unknown> | undefined,
        });
      },
    );
    recorder.close();

    expect(result.success).toBe(true);
    expect(recorder.count).toBeGreaterThan(0);

    // 4. Verify trajectory
    const verification = verifyTrajectory(recorder.trajectoryPath);
    expect(verification.status).toBe("OBSERVATION_VERIFIED");
    expect(verification.total_events).toBe(recorder.count);

    // 5. Replay trajectory
    const replay = replayTrajectory(recorder.trajectoryPath);
    expect(replay.total_events).toBe(recorder.count);
    expect(replay.outcome).not.toBeNull();
    expect(replay.files_touched.length).toBeGreaterThan(0);
    expect(replay.verification.status).toBe("OBSERVATION_VERIFIED");

    // 6. Verify data labels — everything is SYNTHETIC
    const events = TrajectoryRecorder.readTrajectory(recorder.trajectoryPath);
    for (const event of events) {
      expect(event.execution_mode).toBe("synthetic");
    }
  });
});
