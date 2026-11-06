/**
 * Mock agent adapter.
 *
 * Simulates deterministic agent behavior for testing the lab infrastructure.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │ execution_mode = 'synthetic'   ALWAYS.              │
 * │ This adapter is for infrastructure testing ONLY.     │
 * │ Results MUST be labeled SYNTHETIC and never mixed    │
 * │ with real experimental data.                         │
 * └─────────────────────────────────────────────────────┘
 *
 * Behavior profiles control how the mock agent acts:
 *   - 'competent'      — reads relevant files, makes correct changes, runs tests, passes
 *   - 'retry-prone'    — fails commands, retries, eventually succeeds
 *   - 'test-blind'     — modifies code, never runs tests, completes
 *   - 'scope-expanding' — modifies files beyond what the task requires
 */

import fs from "node:fs";
import path from "node:path";
import type { ExecutionMode, BenchmarkTask } from "../types.js";
import type {
  AgentAdapter,
  AgentMessage,
  ToolExecution,
  SessionMetadata,
  TrajectoryEmitter,
  TaskExecutionResult,
} from "./types.js";
import { generateSessionId } from "../types.js";

export type MockBehaviorProfile =
  | "competent"
  | "retry-prone"
  | "test-blind"
  | "scope-expanding"
  | "failing";

export interface MockAgentOptions {
  /** Behavior profile. Default: 'competent' */
  profile?: MockBehaviorProfile;
  /** Simulated delay per step (ms). Default: 10 */
  stepDelay?: number;
  /** Seed for deterministic behavior. Default: 42 */
  seed?: number;
}

/**
 * Simple seeded PRNG (xorshift32) for deterministic mock behavior.
 */
class SeededRandom {
  private state: number;
  constructor(seed: number) {
    this.state = seed | 0 || 1;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.state = x;
    return (x >>> 0) / 0xffffffff;
  }
}

export class MockAgentAdapter implements AgentAdapter {
  readonly executionMode: ExecutionMode = "synthetic";
  readonly adapterName = "mock";
  readonly modelProvider = null;
  readonly modelName = null;

  private readonly profile: MockBehaviorProfile;
  private readonly stepDelay: number;
  private readonly rng: SeededRandom;
  private sessionId: string;
  private startedAt: string;
  private terminated = false;
  private messages: AgentMessage[] = [];

  constructor(options?: MockAgentOptions) {
    this.profile = options?.profile ?? "competent";
    this.stepDelay = options?.stepDelay ?? 10;
    this.rng = new SeededRandom(options?.seed ?? 42);
    this.sessionId = generateSessionId();
    this.startedAt = new Date().toISOString();
  }

  async executeTask(
    task: BenchmarkTask,
    workspacePath: string,
    emit: TrajectoryEmitter,
  ): Promise<TaskExecutionResult> {
    const t0 = Date.now();
    const filesChanged: string[] = [];
    const commandsExecuted: string[] = [];
    let testRuns = 0;
    let retryCount = 0;

    // ── task_started
    emit({
      task_id: task.id,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      event_type: "task_started",
      actor: "system",
      execution_mode: "synthetic",
      repository_state: null,
      payload: {
        task_description: task.description,
        behavior_profile: this.profile,
        data_label: "SYNTHETIC",
      },
    });
    await this.delay();

    // ── Read relevant files
    for (const relFile of task.relevant_files) {
      const absPath = path.join(workspacePath, relFile);
      emit({
        task_id: task.id,
        session_id: this.sessionId,
        timestamp: new Date().toISOString(),
        event_type: "file_read",
        actor: "agent",
        execution_mode: "synthetic",
        repository_state: null,
        path: relFile,
        payload: { exists: fs.existsSync(absPath) },
      });
      await this.delay();
    }

    // ── Agent message: plan
    emit({
      task_id: task.id,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      event_type: "agent_message",
      actor: "agent",
      execution_mode: "synthetic",
      repository_state: null,
      payload: { content: `[SYNTHETIC] I will work on: ${task.description}` },
    });
    await this.delay();

    // ── Profile-specific behavior
    switch (this.profile) {
      case "competent":
        await this.behaviorCompetent(task, workspacePath, emit, filesChanged, commandsExecuted);
        testRuns = 1;
        break;

      case "retry-prone":
        retryCount = await this.behaviorRetryProne(task, workspacePath, emit, filesChanged, commandsExecuted);
        testRuns = retryCount + 1;
        break;

      case "test-blind":
        await this.behaviorTestBlind(task, workspacePath, emit, filesChanged);
        testRuns = 0;
        break;

      case "scope-expanding":
        await this.behaviorScopeExpanding(task, workspacePath, emit, filesChanged, commandsExecuted);
        testRuns = 1;
        break;

      case "failing":
        await this.behaviorFailing(task, workspacePath, emit, filesChanged, commandsExecuted);
        testRuns = 2;
        break;
    }

    // ── task_finished
    const success = this.profile !== "failing";
    emit({
      task_id: task.id,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      event_type: "task_finished",
      actor: "system",
      execution_mode: "synthetic",
      repository_state: null,
      payload: {
        success,
        data_label: "SYNTHETIC",
        files_changed: filesChanged,
        commands_executed: commandsExecuted,
      },
    });

    return {
      session_id: this.sessionId,
      success,
      final_message: `[SYNTHETIC] Task ${success ? "completed" : "failed"}: ${task.id}`,
      duration_ms: Date.now() - t0,
      files_changed: filesChanged,
      commands_executed: commandsExecuted,
      test_runs: testRuns,
      retry_count: retryCount,
    };
  }

  // ──────────────────────────── Behavior: Competent
  private async behaviorCompetent(
    task: BenchmarkTask,
    workspacePath: string,
    emit: TrajectoryEmitter,
    filesChanged: string[],
    commandsExecuted: string[],
  ): Promise<void> {
    // Modify relevant files
    for (const relFile of task.relevant_files.slice(0, 2)) {
      await this.emitFileModification(task, emit, relFile, "// Fixed by competent agent\n");
      filesChanged.push(relFile);
    }

    // Run tests
    await this.emitTestRun(task, emit, commandsExecuted, true);
  }

  // ──────────────────────────── Behavior: Retry-prone
  private async behaviorRetryProne(
    task: BenchmarkTask,
    workspacePath: string,
    emit: TrajectoryEmitter,
    filesChanged: string[],
    commandsExecuted: string[],
  ): Promise<number> {
    const retries = 3;

    for (let attempt = 0; attempt < retries; attempt++) {
      // Modify a file
      const relFile = task.relevant_files[0] ?? "src/index.ts";
      await this.emitFileModification(task, emit, relFile, `// Attempt ${attempt + 1}\n`);

      // Run test — fails on all but last attempt
      const pass = attempt === retries - 1;
      await this.emitTestRun(task, emit, commandsExecuted, pass);

      if (!pass) {
        // Agent message about failure
        emit({
          task_id: task.id,
          session_id: this.sessionId,
          timestamp: new Date().toISOString(),
          event_type: "agent_message",
          actor: "agent",
          execution_mode: "synthetic",
          repository_state: null,
          payload: { content: `[SYNTHETIC] Test failed, retrying (attempt ${attempt + 1})` },
        });
        await this.delay();
      }
    }

    if (!filesChanged.includes(task.relevant_files[0] ?? "src/index.ts")) {
      filesChanged.push(task.relevant_files[0] ?? "src/index.ts");
    }

    return retries - 1;
  }

  // ──────────────────────────── Behavior: Test-blind
  private async behaviorTestBlind(
    task: BenchmarkTask,
    workspacePath: string,
    emit: TrajectoryEmitter,
    filesChanged: string[],
  ): Promise<void> {
    // Modify files but NEVER run tests
    for (const relFile of task.relevant_files.slice(0, 2)) {
      await this.emitFileModification(task, emit, relFile, "// Modified without testing\n");
      filesChanged.push(relFile);
    }

    // Agent message: done (no test mention)
    emit({
      task_id: task.id,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      event_type: "agent_message",
      actor: "agent",
      execution_mode: "synthetic",
      repository_state: null,
      payload: { content: "[SYNTHETIC] Changes complete." },
    });
    await this.delay();
  }

  // ──────────────────────────── Behavior: Scope-expanding
  private async behaviorScopeExpanding(
    task: BenchmarkTask,
    workspacePath: string,
    emit: TrajectoryEmitter,
    filesChanged: string[],
    commandsExecuted: string[],
  ): Promise<void> {
    // Modify relevant files
    for (const relFile of task.relevant_files.slice(0, 2)) {
      await this.emitFileModification(task, emit, relFile, "// Correct fix\n");
      filesChanged.push(relFile);
    }

    // Also modify IRRELEVANT files (scope expansion)
    const extraFiles = ["README.md", "docs/CHANGELOG.md", "src/utils/logger.ts"];
    for (const extraFile of extraFiles) {
      await this.emitFileModification(task, emit, extraFile, "// Unnecessary change\n");
      filesChanged.push(extraFile);

      emit({
        task_id: task.id,
        session_id: this.sessionId,
        timestamp: new Date().toISOString(),
        event_type: "file_created",
        actor: "agent",
        execution_mode: "synthetic",
        repository_state: null,
        path: extraFile,
        payload: { reason: "scope_expansion" },
      });
      await this.delay();
    }

    // Run tests
    await this.emitTestRun(task, emit, commandsExecuted, true);
  }

  // ──────────────────────────── Behavior: Failing
  private async behaviorFailing(
    task: BenchmarkTask,
    workspacePath: string,
    emit: TrajectoryEmitter,
    filesChanged: string[],
    commandsExecuted: string[],
  ): Promise<void> {
    // Modify files incorrectly
    const relFile = task.relevant_files[0] ?? "src/index.ts";
    await this.emitFileModification(task, emit, relFile, "// Incorrect fix\n");
    filesChanged.push(relFile);

    // Run tests — fail
    await this.emitTestRun(task, emit, commandsExecuted, false);

    // Try again — still fail
    await this.emitFileModification(task, emit, relFile, "// Still wrong\n");
    await this.emitTestRun(task, emit, commandsExecuted, false);

    // Give up
    emit({
      task_id: task.id,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      event_type: "agent_message",
      actor: "agent",
      execution_mode: "synthetic",
      repository_state: null,
      payload: { content: "[SYNTHETIC] Unable to resolve the issue." },
    });
    await this.delay();
  }

  // ──────────────────────────── Helper: Emit file modification
  private async emitFileModification(
    task: BenchmarkTask,
    emit: TrajectoryEmitter,
    relFile: string,
    content: string,
  ): Promise<void> {
    emit({
      task_id: task.id,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      event_type: "file_modified",
      actor: "agent",
      execution_mode: "synthetic",
      repository_state: null,
      path: relFile,
      payload: { diff: content },
    });
    await this.delay();
  }

  // ──────────────────────────── Helper: Emit test run
  private async emitTestRun(
    task: BenchmarkTask,
    emit: TrajectoryEmitter,
    commandsExecuted: string[],
    pass: boolean,
  ): Promise<void> {
    const cmd = "npm test";
    commandsExecuted.push(cmd);

    emit({
      task_id: task.id,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      event_type: "test_started",
      actor: "agent",
      execution_mode: "synthetic",
      repository_state: null,
      command: cmd,
    });
    await this.delay();

    emit({
      task_id: task.id,
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      event_type: "test_finished",
      actor: "system",
      execution_mode: "synthetic",
      repository_state: null,
      command: cmd,
      payload: {
        passed: pass ? task.expected_tests.length : 0,
        failed: pass ? 0 : task.expected_tests.length,
        total: task.expected_tests.length,
        success: pass,
      },
    });
    await this.delay();
  }

  // ──────────────────────────── Interface methods

  async sendMessage(message: string): Promise<AgentMessage> {
    const response: AgentMessage = {
      role: "assistant",
      content: `[SYNTHETIC] Acknowledged: ${message.slice(0, 100)}`,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(response);
    return response;
  }

  async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolExecution> {
    return {
      tool_name: toolName,
      arguments: args,
      result: { synthetic: true, message: `[SYNTHETIC] Tool ${toolName} executed` },
      success: true,
      duration_ms: this.stepDelay,
      timestamp: new Date().toISOString(),
    };
  }

  getSessionMetadata(): SessionMetadata {
    return {
      session_id: this.sessionId,
      agent_name: "mock-agent",
      model_provider: null,
      model_name: null,
      execution_mode: "synthetic",
      started_at: this.startedAt,
      capabilities: ["file_read", "file_write", "command_execute", "test_run"],
    };
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }

  private async delay(): Promise<void> {
    if (this.stepDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.stepDelay));
    }
  }
}
