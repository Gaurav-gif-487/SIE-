#!/usr/bin/env tsx

/**
 * Agent Mirror CLI.
 *
 * Commands:
 *   mirror experiment create --name <name> [--tasks <n>]
 *   mirror experiment run --experiment <id> [--randomized] [--condition <control|treatment>] [--control-rate <rate>]
 *   mirror experiment status --experiment <id>
 *   mirror experiment analyze --experiment <id>
 *   mirror experiment report --experiment <id>
 *   mirror trajectory replay <path>
 *   mirror trajectory verify <path>
 */

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { ExperimentRunner } from "../experiment/runner.js";
import { verifyTrajectory, replayTrajectory } from "../trajectory/replay.js";
import type { ExperimentConfig, ExperimentResult } from "../types.js";

const program = new Command();

program
  .name("mirror")
  .description("Agent Mirror Experimental Intelligence Lab CLI")
  .version("1.0.0");

// ────────────────────────────────────────────────── Experiment Subcommands
const expCmd = program.command("experiment").description("Manage and execute AI agent experiments");

expCmd
  .command("create")
  .description("Create a new experiment configuration")
  .option("--name <name>", "Name of the experiment", "pilot-experiment")
  .option("--tasks <count>", "Number of benchmark tasks (1..10)", "10")
  .option("--condition <mode>", "Condition mode: control, treatment, or randomized", "randomized")
  .action((options) => {
    const runner = new ExperimentRunner();
    const tasksCount = Math.min(Math.max(parseInt(options.tasks, 10), 1), 10);
    const config = runner.createExperiment(options.name, tasksCount, options.condition as any);
    console.log(`Experiment created successfully:`);
    console.log(`  ID: ${config.experiment_id}`);
    console.log(`  Name: ${config.name}`);
    console.log(`  Tasks: ${config.task_ids.length}`);
    console.log(`  Data Label: ${config.data_label}`);
    console.log(`  Execution Mode: ${config.execution_mode}`);
  });

expCmd
  .command("run")
  .description("Run an experiment")
  .option("--experiment <id>", "Experiment ID (optional, creates new if omitted)")
  .option("--tasks <count>", "Number of tasks if creating new", "10")
  .option("--condition <mode>", "Condition: control or treatment")
  .option("--randomized", "Assign tasks randomly to conditions", false)
  .option("--control-rate <rate>", "Fraction of control tasks when randomized", "0.5")
  .option("--adapter <type>", "Adapter type: mock (default), free-github, free-ollama", "mock")
  .action(async (options) => {
    const runner = new ExperimentRunner();
    const conditionMode = options.condition
      ? (options.condition as "control" | "treatment")
      : options.randomized
        ? "randomized"
        : "randomized";

    let adapter: any;
    if (options.adapter === "free-github") {
      const { FreeLLMAgentAdapter } = await import("../adapters/free-agent.js");
      adapter = new FreeLLMAgentAdapter({ provider: "github-models" });
    } else if (options.adapter === "free-ollama") {
      const { FreeLLMAgentAdapter } = await import("../adapters/free-agent.js");
      adapter = new FreeLLMAgentAdapter({ provider: "ollama" });
    }

    console.log(`Running experiment (Adapter: ${options.adapter})...`);
    const result = await runner.runExperiment({
      name: options.experiment ?? `experiment-${Date.now()}`,
      tasksCount: parseInt(options.tasks, 10),
      conditionMode,
      controlRate: parseFloat(options.controlRate),
      adapter,
    });

    console.log(`\nExperiment Execution Completed!`);
    console.log(`  ID: ${result.experiment_id}`);
    console.log(`  Data Label: ${result.data_label}`);
    console.log(`  Execution Mode: ${result.execution_mode}`);
    console.log(`  Completed Tasks: ${result.task_results.length}`);
    const successes = result.task_results.filter((t) => t.outcome.task_success).length;
    console.log(`  Successful Tasks: ${successes} / ${result.task_results.length}`);
  });

expCmd
  .command("status")
  .description("Check experiment status")
  .requiredOption("--experiment <id>", "Experiment ID")
  .action((options) => {
    const dataDir = path.join(process.cwd(), "data", "experiments");
    const resultPath = path.join(dataDir, `${options.experiment}-result.json`);
    const configPath = path.join(dataDir, `${options.experiment}-config.json`);

    if (fs.existsSync(resultPath)) {
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as ExperimentResult;
      console.log(`Experiment ${result.experiment_id} (${result.name}): COMPLETED`);
      console.log(`  Data Label: ${result.data_label}`);
      console.log(`  Tasks Completed: ${result.task_results.length}`);
    } else if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as ExperimentConfig;
      console.log(`Experiment ${config.experiment_id} (${config.name}): CREATED (Pending execution)`);
      console.log(`  Tasks Configured: ${config.task_ids.length}`);
    } else {
      console.log(`Experiment ${options.experiment} not found.`);
    }
  });

expCmd
  .command("analyze")
  .description("Analyze experiment results — detectors, statistics, signals")
  .requiredOption("--experiment <id>", "Experiment ID")
  .action(async (options) => {
    const resultPath = path.join(process.cwd(), "data", "experiments", `${options.experiment}-result.json`);
    if (!fs.existsSync(resultPath)) {
      console.error(`Result file not found for experiment: ${options.experiment}`);
      process.exit(1);
    }
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as ExperimentResult;
    const { DetectorSuite } = await import("../detectors/index.js");
    const { TrajectoryRecorder } = await import("../trajectory/recorder.js");
    const { StatisticsEngine } = await import("../analysis/statistics.js");
    const { BENCHMARK_TASKS } = await import("../benchmark/tasks.js");

    const suite = new DetectorSuite();
    const stats = new StatisticsEngine();

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  EXPERIMENT ANALYSIS: ${result.name}`);
    console.log(`  ID: ${result.experiment_id}`);
    console.log(`  Data Label: ${result.data_label}`);
    console.log(`  Execution Mode: ${result.execution_mode}`);
    console.log(`═══════════════════════════════════════════════════════\n`);

    // Run detectors on every task trajectory
    for (const taskRes of result.task_results) {
      if (fs.existsSync(taskRes.trajectory_path)) {
        const events = TrajectoryRecorder.readTrajectory(taskRes.trajectory_path);
        const task = BENCHMARK_TASKS.find((t: any) => t.id === taskRes.task_id);
        const signals = suite.run(events, task?.relevant_files);
        taskRes.detector_signals = signals;
      }
    }

    // Save updated results with detector signals
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

    // Per-task summary
    const controlTasks = result.task_results.filter((t) => t.condition === "control");
    const treatmentTasks = result.task_results.filter((t) => t.condition === "treatment");

    console.log(`  TASK RESULTS`);
    console.log(`  ─────────────────────────────────────────────────`);
    for (const t of result.task_results) {
      const status = t.outcome.task_success ? "✓ PASS" : "✗ FAIL";
      const signals = t.detector_signals.map((s) => s.signal).join(", ") || "none";
      console.log(`  ${status}  ${t.task_id.padEnd(30)} [${t.condition.padEnd(9)}] signals: ${signals}`);
    }

    // Experiment-level statistics
    console.log(`\n  EXPERIMENT STATISTICS`);
    console.log(`  ─────────────────────────────────────────────────`);
    console.log(`  Control tasks:   ${controlTasks.length}`);
    console.log(`  Treatment tasks: ${treatmentTasks.length}`);

    const expStats = stats.calculateExperimentStats(result.task_results);
    console.log(`  Control success rate:   ${(expStats.control_success_rate * 100).toFixed(1)}%`);
    console.log(`  Treatment success rate: ${(expStats.treatment_success_rate * 100).toFixed(1)}%`);
    console.log(`  Absolute effect:        ${(expStats.absolute_treatment_effect * 100).toFixed(1)}%`);
    if (expStats.sample_warning) {
      console.log(`\n  ⚠  ${expStats.sample_warning}`);
    } else {
      console.log(`  P-value:                ${typeof expStats.p_value === "number" ? expStats.p_value.toFixed(4) : expStats.p_value}`);
      console.log(`  Statistically significant: ${expStats.statistically_significant}`);
    }

    // Detector performance
    const signalTypes = ["retry_loop", "test_blindness", "scope_expansion", "duplicate_behavior", "repeated_failure"] as const;
    const anySignals = result.task_results.some((t) => t.detector_signals.length > 0);
    if (anySignals) {
      console.log(`\n  DETECTOR PERFORMANCE`);
      console.log(`  ─────────────────────────────────────────────────`);
      for (const sig of signalTypes) {
        const perf = stats.calculateDetectorPerformance(sig, result.task_results);
        if (perf.true_positives + perf.false_positives > 0) {
          console.log(`  ${sig.padEnd(22)} TP=${perf.true_positives} FP=${perf.false_positives} TN=${perf.true_negatives} FN=${perf.false_negatives} P=${perf.precision.toFixed(2)} R=${perf.recall.toFixed(2)} F1=${perf.f1_score.toFixed(2)}`);
        }
      }
    }

    console.log(`\n═══════════════════════════════════════════════════════\n`);
  });

expCmd
  .command("report")
  .description("Generate experiment report")
  .requiredOption("--experiment <id>", "Experiment ID")
  .action(async (options) => {
    const resultPath = path.join(process.cwd(), "data", "experiments", `${options.experiment}-result.json`);
    if (!fs.existsSync(resultPath)) {
      console.error(`Result file not found for experiment: ${options.experiment}`);
      process.exit(1);
    }
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as ExperimentResult;
    const { ReportGenerator } = await import("../analysis/report-generator.js");
    const generator = new ReportGenerator();
    const output = generator.generateReport(result);

    console.log(`Report generated successfully:`);
    console.log(`  JSON Report: ${output.jsonReportPath}`);
    console.log(`  Markdown Report: ${output.markdownReportPath}`);
    console.log(`\nExecutive Summary:`);
    console.log(`  ${output.summaryText}`);
  });

// ────────────────────────────────────────────────── Trajectory Subcommands
const trajCmd = program.command("trajectory").description("Inspect and verify trajectory files");

trajCmd
  .command("verify")
  .description("Verify hash chain integrity and schema of a trajectory JSONL file")
  .argument("<path>", "Path to trajectory .jsonl file")
  .action((filePath) => {
    const absPath = path.resolve(filePath);
    const result = verifyTrajectory(absPath);

    if (result.status === "OBSERVATION_VERIFIED") {
      console.log(`OBSERVATION VERIFIED`);
      console.log(`  Path: ${result.trajectory_path}`);
      console.log(`  Total Events: ${result.total_events}`);
    } else {
      console.log(`VERIFICATION FAILED`);
      console.log(`  Path: ${result.trajectory_path}`);
      console.log(`  Errors (${result.errors.length}):`);
      for (const err of result.errors) {
        console.log(`   - [${err.type}] Event #${err.event_index}: ${err.message}`);
      }
    }
  });

trajCmd
  .command("replay")
  .description("Reconstruct event sequence and repository state transitions")
  .argument("<path>", "Path to trajectory .jsonl file")
  .action((filePath) => {
    const absPath = path.resolve(filePath);
    const result = replayTrajectory(absPath);

    console.log(`Trajectory Replay Summary:`);
    console.log(`  Status: ${result.verification.status}`);
    console.log(`  Total Events: ${result.total_events}`);
    console.log(`  Files Touched: ${result.files_touched.length}`);
    console.log(`  Commands Executed: ${result.commands_executed.length}`);
    console.log(`  State Transitions: ${result.state_transitions.length}`);
  });

program.parse(process.argv);
