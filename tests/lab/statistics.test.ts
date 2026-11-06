/**
 * Phase 4 tests: Statistical Analysis Engine & Report Generator.
 *
 * Covers:
 * - Detector performance calculations (TP, FP, TN, FN, precision, recall, F1, FPR)
 * - Behavioral risk metrics
 * - Experiment statistics with sample size rule (INSUFFICIENT_SAMPLE for n < 10)
 * - Conservative report generation
 */

import { describe, it, expect } from "vitest";
import type { TaskResult, TaskOutcome } from "../../src/lab/types.js";
import { StatisticsEngine } from "../../src/lab/analysis/statistics.js";
import { ReportGenerator } from "../../src/lab/analysis/report-generator.js";

function makeTaskResult(
  id: string,
  condition: "control" | "treatment",
  success: boolean,
  signals: string[] = [],
): TaskResult {
  const outcome: TaskOutcome = {
    task_success: success,
    tests_passed: success ? 1 : 0,
    tests_failed: success ? 0 : 1,
    time_to_completion_ms: 1000,
    total_commands: 2,
    retry_count: 0,
    files_changed: 1,
    loc_changed: 10,
    duplicate_loc: 0,
    build_status: "success",
    lint_status: "skipped",
    cost_if_available: null,
    evaluation_method: "automated",
  };

  return {
    task_id: id,
    experiment_id: "exp_test",
    session_id: "ses_test",
    condition,
    execution_mode: "synthetic",
    data_label: "SYNTHETIC",
    agent_adapter: "mock",
    model_provider: null,
    model_name: null,
    repository_initial_hash: null,
    repository_final_hash: null,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    outcome,
    trajectory_path: "/tmp/traj.jsonl",
    detector_signals: signals.map((s) => ({
      signal: s as any,
      severity: "medium",
      confidence: 0.85,
      evidence: ["evt_1"],
      detected_at: new Date().toISOString(),
      detector_version: "1.0.0",
    })),
    interventions: [],
  };
}

describe("StatisticsEngine", () => {
  it("calculates detector performance metrics accurately", () => {
    const engine = new StatisticsEngine();
    const results: TaskResult[] = [
      makeTaskResult("t1", "control", false, ["retry_loop"]), // TP
      makeTaskResult("t2", "control", true, ["retry_loop"]),  // FP
      makeTaskResult("t3", "control", true, []),             // TN
      makeTaskResult("t4", "control", false, []),            // FN
    ];

    const metrics = engine.calculateDetectorPerformance("retry_loop", results);
    expect(metrics.true_positives).toBe(1);
    expect(metrics.false_positives).toBe(1);
    expect(metrics.true_negatives).toBe(1);
    expect(metrics.false_negatives).toBe(1);
    expect(metrics.precision).toBe(0.5);
    expect(metrics.recall).toBe(0.5);
    expect(metrics.f1_score).toBe(0.5);
  });

  it("returns INSUFFICIENT_SAMPLE when n < minSampleSize", () => {
    const engine = new StatisticsEngine(10);
    const results: TaskResult[] = [
      makeTaskResult("t1", "control", false),
      makeTaskResult("t2", "treatment", true),
    ];

    const stats = engine.calculateExperimentStats(results);
    expect(stats.control_n).toBe(1);
    expect(stats.treatment_n).toBe(1);
    expect(stats.confidence_interval_95).toBe("INSUFFICIENT_SAMPLE");
    expect(stats.p_value).toBe("INSUFFICIENT_SAMPLE");
    expect(stats.statistically_significant).toBe("INSUFFICIENT_SAMPLE");
    expect(stats.sample_warning).toContain("INSUFFICIENT SAMPLE");
  });

  it("calculates p-value and confidence interval when n >= minSampleSize", () => {
    const engine = new StatisticsEngine(10);
    const results: TaskResult[] = [];

    // 10 control tasks (50% pass)
    for (let i = 0; i < 10; i++) results.push(makeTaskResult(`c_${i}`, "control", i < 5));
    // 10 treatment tasks (90% pass)
    for (let i = 0; i < 10; i++) results.push(makeTaskResult(`t_${i}`, "treatment", i < 9));

    const stats = engine.calculateExperimentStats(results);
    expect(stats.control_n).toBe(10);
    expect(stats.treatment_n).toBe(10);
    expect(stats.control_success_rate).toBe(0.5);
    expect(stats.treatment_success_rate).toBe(0.9);
    expect(stats.absolute_treatment_effect).toBe(0.4);
    expect(Array.isArray(stats.confidence_interval_95)).toBe(true);
    expect(typeof stats.p_value).toBe("number");
  });
});

describe("ReportGenerator", () => {
  it("generates markdown and json reports with conservative conclusions", () => {
    const generator = new ReportGenerator();
    const expResult = {
      experiment_id: "exp_report_test",
      name: "Report Test",
      completed_at: new Date().toISOString(),
      task_results: [makeTaskResult("t1", "control", true)],
      data_label: "SYNTHETIC" as const,
      execution_mode: "synthetic" as const,
    };

    const output = generator.generateReport(expResult);
    expect(output.summaryText).toContain("Insufficient evidence");
  });
});
