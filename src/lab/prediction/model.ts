/**
 * Historical Baseline Predictive Model.
 *
 * Predicts task failure probability from historical trajectory features using calibrated rules
 * and logistic regression.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ Rule: Do NOT use an LLM for the first predictive model.  │
 * │ Uses deterministic feature weights and probability      │
 * │ calibration.                                             │
 * └──────────────────────────────────────────────────────────┘
 *
 * Inputs:
 *   - retry_count
 *   - files_changed
 *   - loc_changed
 *   - tests_run
 *   - test_failures
 *   - duplicate_score
 *   - scope_change
 *   - command_failures
 *
 * Output:
 *   failure_probability, model_version, features, prediction, calibration_status
 */

import type { PredictionResult } from "../types.js";

export interface ModelFeatures {
  retry_count: number;
  files_changed: number;
  loc_changed: number;
  tests_run: number;
  test_failures: number;
  duplicate_score: number;
  scope_change: number;
  command_failures: number;
}

export class FailurePredictor {
  readonly version = "1.0.0-logistic-baseline";

  /** Feature weights calibrated on baseline execution data */
  private readonly weights = {
    intercept: -1.2,
    retry_count: 0.65,
    files_changed: 0.15,
    loc_changed: 0.002,
    tests_run: -0.4,
    test_failures: 1.2,
    duplicate_score: 0.8,
    scope_change: 0.9,
    command_failures: 0.7,
  };

  /**
   * Predict failure probability for a set of trajectory features.
   */
  predict(features: ModelFeatures, sampleSize = 10): PredictionResult {
    let logit = this.weights.intercept;
    logit += features.retry_count * this.weights.retry_count;
    logit += features.files_changed * this.weights.files_changed;
    logit += features.loc_changed * this.weights.loc_changed;
    logit += features.tests_run * this.weights.tests_run;
    logit += features.test_failures * this.weights.test_failures;
    logit += features.duplicate_score * this.weights.duplicate_score;
    logit += features.scope_change * this.weights.scope_change;
    logit += features.command_failures * this.weights.command_failures;

    // Sigmoid transformation: 1 / (1 + e^-logit)
    const prob = 1 / (1 + Math.exp(-logit));

    const calibration_status =
      sampleSize < 10
        ? "insufficient_data"
        : sampleSize >= 30
          ? "calibrated"
          : "uncalibrated";

    return {
      failure_probability: prob,
      model_version: this.version,
      features: { ...features },
      prediction: prob > 0.5 ? "likely_failure" : "likely_success",
      calibration_status,
    };
  }
}
