/**
 * Statistical Analysis Engine.
 *
 * Computes statistical metrics for detectors, behavioral signals, interventions, and experiments:
 *   - Detector performance: TP, FP, TN, FN, precision, recall, F1, false-positive rate
 *   - Behavioral signals: P(failure|signal), P(failure|no signal), risk difference, risk ratio, odds ratio
 *   - Interventions: P(success|intervention), P(success|no intervention)
 *   - Randomized experiments: control/treatment success rates, absolute/relative treatment effects, CI, significance, effect size
 *
 * Integrity Rule:
 *   If sample size n < minSampleSize (default 10 per arm), statistical significance is NOT reported.
 *   Instead, it returns 'INSUFFICIENT_SAMPLE'.
 */

import type { TaskResult, DetectorSignalType } from "../types.js";

export interface DetectorPerformanceMetrics {
  signal: DetectorSignalType;
  true_positives: number;
  false_positives: number;
  true_negatives: number;
  false_negatives: number;
  precision: number;
  recall: number;
  f1_score: number;
  false_positive_rate: number;
}

export interface BehavioralRiskMetrics {
  signal: DetectorSignalType;
  p_failure_given_signal: number;
  p_failure_given_no_signal: number;
  risk_difference: number;
  risk_ratio: number;
  odds_ratio: number;
}

export interface InterventionLiftMetrics {
  p_success_given_intervention: number;
  p_success_given_no_intervention: number;
  lift: number;
}

export interface RandomizedExperimentStats {
  control_n: number;
  treatment_n: number;
  control_success_rate: number;
  treatment_success_rate: number;
  absolute_treatment_effect: number;
  relative_treatment_effect: number;
  confidence_interval_95: [number, number] | "INSUFFICIENT_SAMPLE";
  p_value: number | "INSUFFICIENT_SAMPLE";
  statistically_significant: boolean | "INSUFFICIENT_SAMPLE";
  effect_size: number | "INSUFFICIENT_SAMPLE";
  sample_warning: string | null;
}

export class StatisticsEngine {
  private readonly minSampleSize: number;

  constructor(minSampleSize = 10) {
    this.minSampleSize = minSampleSize;
  }

  /**
   * Calculate detector performance metrics against task failure ground truth.
   */
  calculateDetectorPerformance(
    signalType: DetectorSignalType,
    results: TaskResult[],
  ): DetectorPerformanceMetrics {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;

    for (const r of results) {
      const signalFired = r.detector_signals.some((s) => s.signal === signalType);
      const taskFailed = !r.outcome.task_success;

      if (signalFired && taskFailed) tp++;
      else if (signalFired && !taskFailed) fp++;
      else if (!signalFired && !taskFailed) tn++;
      else if (!signalFired && taskFailed) fn++;
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1_score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const false_positive_rate = fp + tn > 0 ? fp / (fp + tn) : 0;

    return {
      signal: signalType,
      true_positives: tp,
      false_positives: fp,
      true_negatives: tn,
      false_negatives: fn,
      precision,
      recall,
      f1_score,
      false_positive_rate,
    };
  }

  /**
   * Calculate behavioral risk metrics for a signal.
   */
  calculateBehavioralRisk(
    signalType: DetectorSignalType,
    results: TaskResult[],
  ): BehavioralRiskMetrics {
    let signalTotal = 0;
    let signalFailures = 0;
    let noSignalTotal = 0;
    let noSignalFailures = 0;

    for (const r of results) {
      const signalFired = r.detector_signals.some((s) => s.signal === signalType);
      const taskFailed = !r.outcome.task_success;

      if (signalFired) {
        signalTotal++;
        if (taskFailed) signalFailures++;
      } else {
        noSignalTotal++;
        if (taskFailed) noSignalFailures++;
      }
    }

    const pFailSignal = signalTotal > 0 ? signalFailures / signalTotal : 0;
    const pFailNoSignal = noSignalTotal > 0 ? noSignalFailures / noSignalTotal : 0;
    const riskDiff = pFailSignal - pFailNoSignal;
    const riskRatio = pFailNoSignal > 0 ? pFailSignal / pFailNoSignal : pFailSignal > 0 ? Infinity : 1;

    // Odds ratio: (a*d)/(b*c)
    const a = signalFailures;
    const b = signalTotal - signalFailures;
    const c = noSignalFailures;
    const d = noSignalTotal - noSignalFailures;
    const oddsRatio = b * c > 0 ? (a * d) / (b * c) : 1;

    return {
      signal: signalType,
      p_failure_given_signal: pFailSignal,
      p_failure_given_no_signal: pFailNoSignal,
      risk_difference: riskDiff,
      risk_ratio: riskRatio,
      odds_ratio: oddsRatio,
    };
  }

  /**
   * Calculate randomized experiment statistics.
   */
  calculateExperimentStats(results: TaskResult[]): RandomizedExperimentStats {
    const control = results.filter((r) => r.condition === "control");
    const treatment = results.filter((r) => r.condition === "treatment");

    const nControl = control.length;
    const nTreatment = treatment.length;

    const controlPasses = control.filter((r) => r.outcome.task_success).length;
    const treatmentPasses = treatment.filter((r) => r.outcome.task_success).length;

    const pControl = nControl > 0 ? controlPasses / nControl : 0;
    const pTreatment = nTreatment > 0 ? treatmentPasses / nTreatment : 0;

    const absoluteEffect = pTreatment - pControl;
    const relativeEffect = pControl > 0 ? absoluteEffect / pControl : 0;

    // Sample size check
    if (nControl < this.minSampleSize || nTreatment < this.minSampleSize) {
      return {
        control_n: nControl,
        treatment_n: nTreatment,
        control_success_rate: pControl,
        treatment_success_rate: pTreatment,
        absolute_treatment_effect: absoluteEffect,
        relative_treatment_effect: relativeEffect,
        confidence_interval_95: "INSUFFICIENT_SAMPLE",
        p_value: "INSUFFICIENT_SAMPLE",
        statistically_significant: "INSUFFICIENT_SAMPLE",
        effect_size: "INSUFFICIENT_SAMPLE",
        sample_warning: `INSUFFICIENT SAMPLE: Sample size (control=${nControl}, treatment=${nTreatment}) is below required minimum threshold (${this.minSampleSize} per arm). Statistical significance cannot be asserted.`,
      };
    }

    // Standard error for difference in proportions
    const se = Math.sqrt((pControl * (1 - pControl)) / nControl + (pTreatment * (1 - pTreatment)) / nTreatment);
    const z = se > 0 ? absoluteEffect / se : 0;
    const ci95: [number, number] = [absoluteEffect - 1.96 * se, absoluteEffect + 1.96 * se];

    // Approximate two-tailed p-value from z-score
    const pValue = 2 * (1 - this.normalCdf(Math.abs(z)));
    const isSignificant = pValue < 0.05;

    // Cohen's h for proportion difference
    const phiTreatment = 2 * Math.asin(Math.sqrt(pTreatment));
    const phiControl = 2 * Math.asin(Math.sqrt(pControl));
    const effectSize = Math.abs(phiTreatment - phiControl);

    return {
      control_n: nControl,
      treatment_n: nTreatment,
      control_success_rate: pControl,
      treatment_success_rate: pTreatment,
      absolute_treatment_effect: absoluteEffect,
      relative_treatment_effect: relativeEffect,
      confidence_interval_95: ci95,
      p_value: pValue,
      statistically_significant: isSignificant,
      effect_size: effectSize,
      sample_warning: null,
    };
  }

  private normalCdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const prob =
      d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x >= 0 ? 1 - prob : prob;
  }
}
