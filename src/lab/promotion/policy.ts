/**
 * Intelligence Promotion Policy.
 *
 * Enforces strict multi-stage promotion pipeline for behavioral signals and interventions:
 *   OBSERVED → DETECTED → PREDICTIVE → INTERVENTION_TESTED → EFFECTIVE → AUTOMATABLE
 *
 * Integrity Rule:
 *   A detector or signal MUST NEVER be promoted to EFFECTIVE or AUTOMATABLE merely because it
 *   correlates with failure. Promotion requires empirical evidence that the intervention itself
 *   statistically improves outcomes compared to the control arm.
 */

import type {
  PromotionState,
  PromotionRecord,
  DetectorSignalType,
} from "../types.js";

export interface PromotionCriteria {
  min_observed_events: number;
  min_detection_precision: number;
  min_predictive_risk_ratio: number;
  min_treatment_lift: number;
  require_stat_significance: boolean;
}

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = {
  min_observed_events: 20,
  min_detection_precision: 0.7,
  min_predictive_risk_ratio: 1.5,
  min_treatment_lift: 0.15, // 15% absolute lift
  require_stat_significance: true,
};

export class IntelligencePromotionPolicy {
  private readonly criteria: PromotionCriteria;

  constructor(criteria?: Partial<PromotionCriteria>) {
    this.criteria = { ...DEFAULT_PROMOTION_CRITERIA, ...criteria };
  }

  /**
   * Evaluate whether a signal can be promoted to the next state based on empirical evidence.
   */
  evaluatePromotion(
    currentRecord: PromotionRecord,
    metrics: {
      observed_events: number;
      precision: number;
      risk_ratio: number;
      treatment_lift: number;
      is_statistically_significant: boolean;
    },
  ): { canPromote: boolean; nextState: PromotionState; reason: string } {
    const state = currentRecord.current_state;

    switch (state) {
      case "OBSERVED":
        if (metrics.observed_events >= this.criteria.min_observed_events) {
          return {
            canPromote: true,
            nextState: "DETECTED",
            reason: `Observed events (${metrics.observed_events}) met threshold (${this.criteria.min_observed_events}).`,
          };
        }
        return { canPromote: false, nextState: state, reason: "Insufficient observed events." };

      case "DETECTED":
        if (metrics.precision >= this.criteria.min_detection_precision) {
          return {
            canPromote: true,
            nextState: "PREDICTIVE",
            reason: `Detection precision (${(metrics.precision * 100).toFixed(1)}%) met threshold (${(this.criteria.min_detection_precision * 100).toFixed(1)}%).`,
          };
        }
        return { canPromote: false, nextState: state, reason: "Precision below threshold." };

      case "PREDICTIVE":
        if (metrics.risk_ratio >= this.criteria.min_predictive_risk_ratio) {
          return {
            canPromote: true,
            nextState: "INTERVENTION_TESTED",
            reason: `Predictive risk ratio (${metrics.risk_ratio.toFixed(2)}) met threshold (${this.criteria.min_predictive_risk_ratio}).`,
          };
        }
        return { canPromote: false, nextState: state, reason: "Risk ratio below threshold." };

      case "INTERVENTION_TESTED":
        if (
          metrics.treatment_lift >= this.criteria.min_treatment_lift &&
          (!this.criteria.require_stat_significance || metrics.is_statistically_significant)
        ) {
          return {
            canPromote: true,
            nextState: "EFFECTIVE",
            reason: `Intervention produced measurable lift (${(metrics.treatment_lift * 100).toFixed(1)}%) with statistical significance.`,
          };
        }
        return {
          canPromote: false,
          nextState: state,
          reason: "Correlation alone cannot promote signal. Proven intervention outcome lift is required.",
        };

      case "EFFECTIVE":
        if (metrics.is_statistically_significant && metrics.treatment_lift >= 0.2) {
          return {
            canPromote: true,
            nextState: "AUTOMATABLE",
            reason: "Intervention efficacy verified at high confidence across multiple runs.",
          };
        }
        return { canPromote: false, nextState: state, reason: "Lift or statistical power insufficient for automation." };

      case "AUTOMATABLE":
        return { canPromote: false, nextState: state, reason: "Signal is already at highest state AUTOMATABLE." };
    }
  }
}
