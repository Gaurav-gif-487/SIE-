/**
 * Phase 3 tests: Detector correctness.
 *
 * Covers:
 * - Retry loop detector (repeated failed commands/tests)
 * - Test blindness detector (code modified without tests run)
 * - Scope expansion detector (modifying files outside task scope)
 * - Duplicate behavior detector
 * - Repeated failure detector
 * - Evidence event IDs present in all signals
 */

import { describe, it, expect } from "vitest";
import type { TrajectoryEvent } from "../../src/lab/types.js";
import { DetectorSuite } from "../../src/lab/detectors/index.js";
import { RetryLoopDetector } from "../../src/lab/detectors/retry-loop.js";
import { TestBlindnessDetector } from "../../src/lab/detectors/test-blindness.js";
import { ScopeExpansionDetector } from "../../src/lab/detectors/scope-expansion.js";

function makeEvent(
  id: string,
  type: TrajectoryEvent["event_type"],
  extra: Partial<TrajectoryEvent> = {},
): TrajectoryEvent {
  return {
    event_id: id,
    task_id: "task_001",
    experiment_id: "exp_001",
    session_id: "ses_001",
    timestamp: new Date().toISOString(),
    condition: "treatment",
    event_type: type,
    actor: "agent",
    execution_mode: "synthetic",
    repository_state: null,
    event_hash: "hash",
    previous_event_hash: null,
    ...extra,
  };
}

describe("Detectors", () => {
  it("RetryLoopDetector identifies retries and exposes evidence IDs", () => {
    const detector = new RetryLoopDetector();
    const events: TrajectoryEvent[] = [
      makeEvent("evt_1", "task_started", { actor: "system" }),
      makeEvent("evt_2", "test_finished", { payload: { success: false, failed: 1 } }),
      makeEvent("evt_3", "file_modified", { path: "src/math.js" }),
      makeEvent("evt_4", "test_finished", { payload: { success: false, failed: 1 } }),
    ];

    const signals = detector.detect(events);
    expect(signals.length).toBe(1);
    expect(signals[0]!.signal).toBe("retry_loop");
    expect(signals[0]!.evidence).toEqual(["evt_2", "evt_4"]);
    expect(signals[0]!.confidence).toBeGreaterThan(0.7);
  });

  it("TestBlindnessDetector detects code modifications without test execution", () => {
    const detector = new TestBlindnessDetector();
    const events: TrajectoryEvent[] = [
      makeEvent("evt_1", "task_started"),
      makeEvent("evt_2", "file_modified", { path: "src/math.js" }),
      makeEvent("evt_3", "task_finished"),
    ];

    const signals = detector.detect(events);
    expect(signals.length).toBe(1);
    expect(signals[0]!.signal).toBe("test_blindness");
    expect(signals[0]!.evidence).toContain("evt_2");
  });

  it("ScopeExpansionDetector detects modifications to files outside task scope", () => {
    const detector = new ScopeExpansionDetector();
    const events: TrajectoryEvent[] = [
      makeEvent("evt_1", "file_modified", { path: "src/math.js" }),
      makeEvent("evt_2", "file_modified", { path: "README.md" }),
    ];

    const signals = detector.detect(events, ["src/math.js"]);
    expect(signals.length).toBe(1);
    expect(signals[0]!.signal).toBe("scope_expansion");
    expect(signals[0]!.evidence).toEqual(["evt_2"]);
  });

  it("DetectorSuite runs all detectors against events", () => {
    const suite = new DetectorSuite();
    const events: TrajectoryEvent[] = [
      makeEvent("evt_1", "file_modified", { path: "src/math.js" }),
      makeEvent("evt_2", "test_finished", { payload: { success: false, failed: 1 } }),
      makeEvent("evt_3", "test_finished", { payload: { success: false, failed: 1 } }),
    ];

    const signals = suite.run(events, ["src/math.js"]);
    expect(signals.length).toBeGreaterThan(0);
    for (const sig of signals) {
      expect(sig.evidence.length).toBeGreaterThan(0);
    }
  });
});
