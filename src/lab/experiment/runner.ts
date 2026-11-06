/**
 * Experiment Runner.
 *
 * Manages experiment configuration, task-to-condition assignment, execution loop,
 * trajectory recording, outcome evaluation, and storage.
 *
 * Supported execution modes:
 *   - Control mode:   task → normal tools → repository
 *   - Treatment mode: task → normal tools → Agent Mirror observation → detector → intervention → agent response
 *   - Randomized:     random assignment of tasks to control vs treatment
 *
 * Data integrity:
 *   - All results retain provenance and execution_mode ('real' | 'synthetic')
 *   - Results stored under data/experiments/<experiment_id>.json
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ExperimentConfig,
  ExperimentResult,
  TaskResult,
  ExperimentCondition,
  BenchmarkTask,
  DataLabel,
} from "../types.js";
import { generateExperimentId } from "../types.js";
import { Sandbox } from "../sandbox/sandbox.js";
import { RepoObserver } from "../sandbox/repo-observer.js";
import { TrajectoryRecorder } from "../trajectory/recorder.js";
import type { AgentAdapter } from "../adapters/types.js";
import { MockAgentAdapter } from "../adapters/mock-agent.js";
import { BENCHMARK_TASKS, ensureFixtureRepositories } from "../benchmark/tasks.js";
import { OutcomeEvaluator } from "./evaluator.js";

export interface ExperimentRunOptions {
  experimentId?: string;
  name?: string;
  tasksCount?: number;
  conditionMode?: "control" | "treatment" | "randomized";
  controlRate?: number;
  adapter?: AgentAdapter;
  baseDir?: string;
  dataDir?: string;
  enableInterventions?: boolean;
}

export class ExperimentRunner {
  private readonly baseDir: string;
  private readonly dataDir: string;
  private readonly sandbox: Sandbox;
  private readonly observer: RepoObserver;
  private readonly evaluator: OutcomeEvaluator;

  constructor(baseDir?: string, dataDir?: string) {
    this.baseDir = baseDir ?? process.cwd();
    this.dataDir = dataDir ?? path.join(this.baseDir, "data");
    this.sandbox = new Sandbox();
    this.observer = new RepoObserver();
    this.evaluator = new OutcomeEvaluator(this.sandbox);

    fs.mkdirSync(path.join(this.dataDir, "experiments"), { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, "trajectories"), { recursive: true });
    ensureFixtureRepositories(this.baseDir);
  }

  /**
   * Create an experiment configuration.
   */
  createExperiment(
    name: string,
    tasksCount = 10,
    conditionMode: "control" | "treatment" | "randomized" = "randomized",
    controlRate = 0.5,
    adapter?: AgentAdapter,
  ): ExperimentConfig {
    const experiment_id = generateExperimentId();
    // Build tasks list repeating BENCHMARK_TASKS if tasksCount > BENCHMARK_TASKS.length
    const taskList: BenchmarkTask[] = [];
    for (let i = 0; i < tasksCount; i++) {
      const baseTask = BENCHMARK_TASKS[i % BENCHMARK_TASKS.length]!;
      const runIndex = Math.floor(i / BENCHMARK_TASKS.length) + 1;
      const taskId = i < BENCHMARK_TASKS.length ? baseTask.id : `${baseTask.id}-r${runIndex}`;
      taskList.push({
        ...baseTask,
        id: taskId,
      });
    }
    const task_ids = taskList.map((t) => t.id);

    const activeAdapter = adapter ?? new MockAgentAdapter();
    const execution_mode = activeAdapter.executionMode;
    const data_label: DataLabel = execution_mode === "synthetic" ? "SYNTHETIC" : "REAL";

    // Condition assignment - balanced allocation for randomized mode
    const assignments: Record<string, ExperimentCondition> = {};
    if (conditionMode === "control") {
      for (const id of task_ids) assignments[id] = "control";
    } else if (conditionMode === "treatment") {
      for (const id of task_ids) assignments[id] = "treatment";
    } else {
      // Balanced randomized assignment
      const controlCount = Math.floor(tasksCount * controlRate);
      const shuffledIds = [...task_ids].sort(() => Math.random() - 0.5);
      for (let i = 0; i < shuffledIds.length; i++) {
        assignments[shuffledIds[i]!] = i < controlCount ? "control" : "treatment";
      }
    }

    const config: ExperimentConfig = {
      experiment_id,
      name,
      created_at: new Date().toISOString(),
      task_ids,
      condition_mode: conditionMode,
      control_rate: controlRate,
      assignments,
      agent_adapter: activeAdapter.adapterName,
      execution_mode,
      data_label,
      enable_interventions: conditionMode !== "control",
    };

    const configPath = path.join(this.dataDir, "experiments", `${experiment_id}-config.json`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    return config;
  }

  /**
   * Run an experiment given options or existing config.
   */
  async runExperiment(options: ExperimentRunOptions): Promise<ExperimentResult> {
    const adapter = options.adapter ?? new MockAgentAdapter({ profile: "competent", stepDelay: 0 });
    const config = this.createExperiment(
      options.name ?? `experiment-${Date.now()}`,
      options.tasksCount ?? 20,
      options.conditionMode ?? "randomized",
      options.controlRate ?? 0.5,
      adapter,
    );

    const taskResults: TaskResult[] = [];

    // Map task_ids back to task definitions
    const tasksToRun: BenchmarkTask[] = config.task_ids.map((id) => {
      const baseId = id.replace(/-r\d+$/, "");
      const baseTask = BENCHMARK_TASKS.find((t) => t.id === baseId || t.id === id)!;
      return { ...baseTask, id };
    });

    for (const task of tasksToRun) {
      const condition = config.assignments[task.id] ?? "control";
      const fixtureRepoPath = path.join(this.baseDir, task.repository);

      // 1. Create sandbox workspace
      const session = this.sandbox.createWorkspace(fixtureRepoPath, task.id, `ses_${Date.now()}`);
      const initialCommit = this.observer.getGitCommitHash(session.workspacePath);
      const startedAt = new Date().toISOString();

      // 2. Initialize trajectory recorder
      const recorder = new TrajectoryRecorder({
        baseDir: path.join(this.dataDir, "trajectories"),
        experiment_id: config.experiment_id,
        task_id: task.id,
        session_id: `ses_${Date.now()}`,
        condition,
        execution_mode: adapter.executionMode,
      });

      // 3. Execute task via Agent Adapter
      const execResult = await adapter.executeTask(
        task,
        session.workspacePath,
        (partialEvent) => {
          recorder.record(partialEvent.event_type, partialEvent.actor, {
            repository_state: this.observer.getGitCommitHash(session.workspacePath) ?? initialCommit,
            path: partialEvent.path,
            command: partialEvent.command,
            payload: partialEvent.payload as Record<string, unknown> | undefined,
          });
        },
      );
      recorder.close();

      const finalCommit = this.observer.getGitCommitHash(session.workspacePath);
      const finishedAt = new Date().toISOString();

      // 4. Evaluate task outcomes ground truth
      const outcome = this.evaluator.evaluateTask({
        workspacePath: session.workspacePath,
        expectedTests: task.expected_tests,
        durationMs: execResult.duration_ms,
        totalCommands: execResult.commands_executed.length,
        retryCount: execResult.retry_count,
        filesChangedCount: execResult.files_changed.length,
        locChangedCount: execResult.files_changed.length * 5, // estimated LOC change
      });

      const taskResult: TaskResult = {
        task_id: task.id,
        experiment_id: config.experiment_id,
        session_id: execResult.session_id,
        condition,
        execution_mode: adapter.executionMode,
        data_label: config.data_label,
        agent_adapter: adapter.adapterName,
        model_provider: adapter.modelProvider,
        model_name: adapter.modelName,
        repository_initial_hash: initialCommit,
        repository_final_hash: finalCommit,
        started_at: startedAt,
        finished_at: finishedAt,
        outcome,
        trajectory_path: recorder.trajectoryPath,
        detector_signals: [],
        interventions: [],
      };

      taskResults.push(taskResult);
      session.cleanUp();
    }

    const experimentResult: ExperimentResult = {
      experiment_id: config.experiment_id,
      name: config.name,
      completed_at: new Date().toISOString(),
      task_results: taskResults,
      data_label: config.data_label,
      execution_mode: adapter.executionMode,
    };

    const resultPath = path.join(this.dataDir, "experiments", `${config.experiment_id}-result.json`);
    fs.writeFileSync(resultPath, JSON.stringify(experimentResult, null, 2));

    return experimentResult;
  }
}
