/**
 * Phase 3 tests: Intervention Engine.
 *
 * Covers:
 * - Policy selection (WARN, SUGGEST_TEST, SUGGEST_SCOPE_REVIEW, SUGGEST_STOP_RETRYING)
 * - Intervention delivery logging with signal, confidence, timestamp, agent_response, accepted/ignored
 * - Opt-in behavior (does NOT automatically intervene unless explicitly enabled)
 */

import { describe, it, expect } from "vitest";
import type { DetectorSignal } from "../../src/lab/types.js";
import { InterventionEngine } from "../../src/lab/interventions/engine.js";
import { MockAgentAdapter } from "../../src/lab/adapters/mock-agent.js";

const SAMPLE_SIGNAL: DetectorSignal = {
  signal: "retry_loop",
  severity: "medium",
  confidence: 0.85,
  evidence: ["evt_1", "evt_2"],
  detected_at: new Date().toISOString(),
  detector_version: "1.0.0",
};

describe("InterventionEngine", () => {
  it("defaults to disabled interventions", () => {
    const engine = new InterventionEngine();
    expect(engine.isEnabled).toBe(false);
  });

  it("selects appropriate intervention policy", () => {
    const engine = new InterventionEngine(true);
    expect(engine.selectPolicy(SAMPLE_SIGNAL)).toBe("SUGGEST_STOP_RETRYING");

    const testBlindSignal: DetectorSignal = { ...SAMPLE_SIGNAL, signal: "test_blindness" };
    expect(engine.selectPolicy(testBlindSignal)).toBe("SUGGEST_TEST");

    const scopeSignal: DetectorSignal = { ...SAMPLE_SIGNAL, signal: "scope_expansion" };
    expect(engine.selectPolicy(scopeSignal)).toBe("SUGGEST_SCOPE_REVIEW");
  });

  it("does not deliver interventions when disabled", async () => {
    const disabledEngine = new InterventionEngine(false);
    const adapter = new MockAgentAdapter({ stepDelay: 0 });

    const record = await disabledEngine.processSignal(SAMPLE_SIGNAL, adapter);
    expect(record.delivered).toBe(false);
    expect(record.agent_response).toBeNull();
  });

  it("delivers intervention and logs agent response when enabled", async () => {
    const enabledEngine = new InterventionEngine(true);
    const adapter = new MockAgentAdapter({ stepDelay: 0 });

    const record = await enabledEngine.processSignal(SAMPLE_SIGNAL, adapter);
    expect(record.delivered).toBe(true);
    expect(record.agent_response).not.toBeNull();
    expect(record.accepted).toBe(true);
  });
});
