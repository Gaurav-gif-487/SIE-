/**
 * Phase 2 tests: Experiment runner, task randomization, and evaluator.
 *
 * Covers:
 * - 10 benchmark task definitions
 * - Task assignment to control vs treatment conditions (fixed & randomized)
 * - Full experiment run execution
 * - Automated ground truth evaluation
 * - Data label provenance ('SYNTHETIC' vs 'REAL')
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BENCHMARK_TASKS } from "../../src/lab/benchmark/tasks.js";
import { ExperimentRunner } from "../../src/lab/experiment/runner.js";
import { OutcomeEvaluator } from "../../src/lab/experiment/evaluator.js";
import { MockAgentAdapter } from "../../src/lab/adapters/mock-agent.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mirror-exp-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("Benchmark Tasks", () => {
  it("provides 10 deterministic benchmark tasks", () => {
    expect(BENCHMARK_TASKS.length).toBe(10);
    const categories = new Set(BENCHMARK_TASKS.map((t) => t.category));
    expect(categories.size).toBe(10);
  });
});

describe("ExperimentRunner", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = tmpDir();
  });

  afterEach(() => {
    cleanup(rootDir);
  });

  it("creates experiment configuration with condition assignments", () => {
    const dataDir = path.join(rootDir, "data");
    const runner = new ExperimentRunner(rootDir, dataDir);

    const configControl = runner.createExperiment("test-control", 5, "control");
    expect(Object.values(configControl.assignments).every((c) => c === "control")).toBe(true);

    const configTreatment = runner.createExperiment("test-treatment", 5, "treatment");
    expect(Object.values(configTreatment.assignments).every((c) => c === "treatment")).toBe(true);

    const configRandom = runner.createExperiment("test-random", 10, "randomized", 0.5);
    const conditions = Object.values(configRandom.assignments);
    expect(conditions.includes("control")).toBe(true);
    expect(conditions.includes("treatment")).toBe(true);
  });

  it("executes experiment end-to-end with MockAgentAdapter", async () => {
    const dataDir = path.join(rootDir, "data");
    const runner = new ExperimentRunner(rootDir, dataDir);
    const adapter = new MockAgentAdapter({ profile: "competent", stepDelay: 0 });

    const result = await runner.runExperiment({
      name: "e2e-exp",
      tasksCount: 3,
      conditionMode: "randomized",
      adapter,
    });

    expect(result.experiment_id).toMatch(/^exp_/);
    expect(result.data_label).toBe("SYNTHETIC");
    expect(result.execution_mode).toBe("synthetic");
    expect(result.task_results.length).toBe(3);

    for (const res of result.task_results) {
      expect(res.outcome.task_success).toBe(true);
      expect(res.data_label).toBe("SYNTHETIC");
      expect(fs.existsSync(res.trajectory_path)).toBe(true);
    }
  });
});

describe("OutcomeEvaluator", () => {
  let rootDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    rootDir = tmpDir();
    workspaceDir = path.join(rootDir, "ws");
    fs.mkdirSync(path.join(workspaceDir, "test"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "package.json"),
      JSON.stringify({ name: "test-pkg", scripts: { test: "node --test" } }),
    );
    fs.writeFileSync(
      path.join(workspaceDir, "test", "dummy.test.js"),
      'import { test } from "node:test";\ntest("pass", () => {});\n',
    );
  });

  afterEach(() => {
    cleanup(rootDir);
  });

  it("evaluates automated task pass outcome", () => {
    const evaluator = new OutcomeEvaluator();
    const outcome = evaluator.evaluateTask({
      workspacePath: workspaceDir,
      expectedTests: ["dummy.test.js"],
      durationMs: 100,
      totalCommands: 1,
      retryCount: 0,
      filesChangedCount: 1,
      locChangedCount: 10,
    });

    expect(outcome.task_success).toBe(true);
    expect(outcome.tests_passed).toBe(1);
    expect(outcome.tests_failed).toBe(0);
    expect(outcome.evaluation_method).toBe("automated");
  });
});
