/**
 * Intervention Engine.
 *
 * Evaluates detector signals against intervention policies and formats interventions.
 * Supported Policies:
 *   - WARN
 *   - SUGGEST_TEST
 *   - SUGGEST_SCOPE_REVIEW
 *   - SUGGEST_STOP_RETRYING
 *
 * Every intervention is logged with:
 *   signal, confidence, intervention, timestamp, agent_response, accepted/ignored
 *
 * Important Rule:
 *   Does NOT automatically intervene unless the experiment explicitly enables interventions.
 */

import type {
  DetectorSignal,
  InterventionPolicy,
  InterventionRecord,
  DetectorSignalType,
} from "../types.js";
import { generateInterventionId } from "../types.js";
import type { AgentAdapter } from "../adapters/types.js";

export class InterventionEngine {
  private readonly enabled: boolean;

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Determine intervention policy based on detector signal type and severity.
   */
  selectPolicy(signal: DetectorSignal): InterventionPolicy {
    switch (signal.signal) {
      case "retry_loop":
      case "repeated_failure":
        return "SUGGEST_STOP_RETRYING";
      case "test_blindness":
        return "SUGGEST_TEST";
      case "scope_expansion":
        return "SUGGEST_SCOPE_REVIEW";
      default:
        return "WARN";
    }
  }

  /**
   * Format message for intervention policy.
   */
  formatMessage(policy: InterventionPolicy, signal: DetectorSignal): string {
    switch (policy) {
      case "SUGGEST_STOP_RETRYING":
        return `[AGENT_MIRROR_INTERVENTION] Detected repeated failure/retry loop (${signal.signal}, confidence ${signal.confidence.toFixed(2)}). Consider stepping back, reading error output carefully, or checking relevant source files.`;
      case "SUGGEST_TEST":
        return `[AGENT_MIRROR_INTERVENTION] Code modifications detected without running unit tests (${signal.signal}, confidence ${signal.confidence.toFixed(2)}). Please execute 'npm test' to verify changes.`;
      case "SUGGEST_SCOPE_REVIEW":
        return `[AGENT_MIRROR_INTERVENTION] Modifications detected outside defined task scope (${signal.signal}, confidence ${signal.confidence.toFixed(2)}). Please review changed files to avoid unnecessary scope expansion.`;
      case "WARN":
      default:
        return `[AGENT_MIRROR_INTERVENTION] Behavioral signal observed: ${signal.signal} (confidence ${signal.confidence.toFixed(2)}).`;
    }
  }

  /**
   * Evaluate detector signal and optionally deliver intervention to agent.
   */
  async processSignal(
    signal: DetectorSignal,
    adapter?: AgentAdapter,
  ): Promise<InterventionRecord> {
    const policy = this.selectPolicy(signal);
    const message = this.formatMessage(policy, signal);
    const timestamp = new Date().toISOString();
    const id = generateInterventionId();

    if (!this.enabled || !adapter) {
      return {
        intervention_id: id,
        signal: signal.signal,
        signal_confidence: signal.confidence,
        policy,
        message,
        timestamp,
        agent_response: null,
        accepted: null,
        delivered: false,
      };
    }

    // Deliver intervention message to agent
    try {
      const response = await adapter.sendMessage(message);
      const content = response.content.toLowerCase();
      const accepted = content.includes("acknowledge") || content.includes("agree") || content.includes("will") || content.includes("ok");

      return {
        intervention_id: id,
        signal: signal.signal,
        signal_confidence: signal.confidence,
        policy,
        message,
        timestamp,
        agent_response: response.content,
        accepted,
        delivered: true,
      };
    } catch (err) {
      return {
        intervention_id: id,
        signal: signal.signal,
        signal_confidence: signal.confidence,
        policy,
        message,
        timestamp,
        agent_response: (err as Error).message,
        accepted: false,
        delivered: false,
      };
    }
  }
}
