import { Soundness } from "../canonical/model.js";

/**
 * Verification policy.
 *
 * Decides whether a conclusion should be independently challenged before it
 * is allowed to be presented as resolved. This is a deterministic decision
 * over counted signals the engine already has — never a learned or
 * probabilistic gate, matching the rest of the planner (see
 * `planning/planner.ts`: "transparent deterministic heuristic, NOT a
 * calibrated probability").
 */

export type VerificationLevel = "not-required" | "recommended" | "required";

export type TaskCriticality = "low" | "normal" | "high";

export interface VerificationSignals {
  criticality: TaskCriticality;
  /** ResidualRisk.criticalSites for the primary result */
  residualRiskSites: number;
  /** store.conflicts().length > 0, i.e. EvidenceStatus.CONFLICTING already present */
  hasConflictingEvidence: boolean;
  /** any unresolved-site classified with risk "dynamic-dispatch" */
  hasDynamicDispatch: boolean;
  /** any unresolved-site classified with risk "reflection" */
  hasReflection: boolean;
  /** coverage was relevant to this query and no coverage data was ingested */
  hasIncompleteCoverage: boolean;
  /** number of sites the primary analysis could not resolve at all */
  unresolvedSiteCount: number;
  /** weakest Soundness among the analyses that actually produced this result */
  weakestSoundness: Soundness;
}

export interface VerificationPolicyConfig {
  /**
   * criticalSites at or above this value alone forces verification,
   * regardless of task criticality. This is the "configurable risk
   * threshold" the requirement asks for.
   */
  requiredRiskThreshold: number;
  /** unresolved sites at or above this alone makes verification recommended */
  unresolvedSiteFloor: number;
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicyConfig = {
  requiredRiskThreshold: 1,
  unresolvedSiteFloor: 1,
};

const SOUND_ENOUGH: Soundness[] = ["SOUND", "SOUND_UNDER_ASSUMPTIONS"];

/** Ordered strongest → weakest. */
const STRENGTH_ORDER: Soundness[] = ["SOUND", "SOUND_UNDER_ASSUMPTIONS", "HEURISTIC", "OBSERVATIONAL", "SPECULATIVE"];

/** The weakest soundness class among the analyses that actually contributed evidence. */
export function weakestSoundness(values: Soundness[]): Soundness {
  let idx = 0;
  for (const v of values) idx = Math.max(idx, STRENGTH_ORDER.indexOf(v));
  return STRENGTH_ORDER[idx]!;
}

export interface VerificationDecision {
  level: VerificationLevel;
  reasons: string[];
}

/**
 * Decide the verification level for one query. Verifying every query
 * unconditionally would defeat the point (see §15 planner-overhead
 * discipline) — this only escalates when a concrete, named signal is
 * present, and always says which one.
 */
export function decideVerification(
  signals: VerificationSignals,
  config: VerificationPolicyConfig = DEFAULT_VERIFICATION_POLICY,
): VerificationDecision {
  const requiredReasons: string[] = [];
  if (signals.hasConflictingEvidence) {
    requiredReasons.push("evidence sources already disagree (EvidenceStatus.CONFLICTING present)");
  }
  if (signals.hasDynamicDispatch) {
    requiredReasons.push("a call site depends on dynamic dispatch that could not be statically pinned");
  }
  if (signals.hasReflection) {
    requiredReasons.push("a call site depends on reflection that could not be statically pinned");
  }
  if (signals.residualRiskSites >= config.requiredRiskThreshold) {
    requiredReasons.push(
      `residual risk sites (${signals.residualRiskSites}) at/above the required threshold (${config.requiredRiskThreshold})`,
    );
  }
  if (signals.criticality === "high" && signals.residualRiskSites > 0) {
    requiredReasons.push("task marked high-criticality and residual risk is nonzero");
  }
  if (requiredReasons.length > 0) return { level: "required", reasons: requiredReasons };

  const recommendedReasons: string[] = [];
  if (signals.unresolvedSiteCount >= config.unresolvedSiteFloor) {
    recommendedReasons.push(`${signals.unresolvedSiteCount} call site(s) the primary analysis could not resolve`);
  }
  if (signals.hasIncompleteCoverage) {
    recommendedReasons.push("coverage data was relevant but incomplete or absent");
  }
  if (!SOUND_ENOUGH.includes(signals.weakestSoundness)) {
    recommendedReasons.push(
      `weakest contributing analysis is only ${signals.weakestSoundness}, not SOUND/SOUND_UNDER_ASSUMPTIONS`,
    );
  }
  if (signals.criticality === "high") {
    recommendedReasons.push("task marked high-criticality");
  }
  if (recommendedReasons.length > 0) return { level: "recommended", reasons: recommendedReasons };

  return {
    level: "not-required",
    reasons: [
      "no unresolved sites, no conflicting evidence, no dynamic dispatch/reflection, residual risk below threshold",
    ],
  };
}
