/**
 * Agent adapter interface.
 *
 * Every agent adapter (mock, hosted LLM, local LLM, or any future coding agent)
 * implements this interface.
 *
 * The adapter clearly distinguishes REAL from SYNTHETIC execution
 * via executionMode, which is fixed at construction time.
 */

import type { ExecutionMode, BenchmarkTask, TrajectoryEvent } from "../types.js";

/**
 * Message from or to the agent.
 */
export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

/**
 * Tool execution request/result.
 */
export interface ToolExecution {
  tool_name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
  duration_ms: number;
  timestamp: string;
}

/**
 * Metadata about the current agent session.
 */
export interface SessionMetadata {
  session_id: string;
  agent_name: string;
  model_provider: string | null;
  model_name: string | null;
  execution_mode: ExecutionMode;
  started_at: string;
  capabilities: string[];
}

/**
 * Callback for emitting trajectory events during agent execution.
 * The adapter calls this for every observable action.
 */
export type TrajectoryEmitter = (event: Omit<TrajectoryEvent,
  "event_id" | "event_hash" | "previous_event_hash" | "experiment_id" | "condition"
>) => void;

/**
 * Result of executing a task through an agent adapter.
 */
export interface TaskExecutionResult {
  session_id: string;
  success: boolean;
  /** Agent's final message/summary, if any */
  final_message: string | null;
  /** Total wall-clock time in ms */
  duration_ms: number;
  /** Files the agent modified */
  files_changed: string[];
  /** Commands the agent executed */
  commands_executed: string[];
  /** Number of test runs */
  test_runs: number;
  /** Number of retries observed */
  retry_count: number;
}

/**
 * The adapter interface that all agent implementations must satisfy.
 *
 * Implementations:
 *   - MockAgentAdapter (synthetic, for infrastructure testing)
 *   - Future: CopilotAdapter, OpenAIAdapter, AnthropicAdapter,
 *             GeminiAdapter, OpenHandsAdapter
 */
export interface AgentAdapter {
  /** Fixed at construction: 'real' for actual AI agents, 'synthetic' for mocks. */
  readonly executionMode: ExecutionMode;

  /** Human-readable name of this adapter (e.g., "mock", "copilot", "openai"). */
  readonly adapterName: string;

  /** Model provider, if applicable (e.g., "openai", "anthropic"). */
  readonly modelProvider: string | null;

  /** Model name, if applicable (e.g., "gpt-4o", "claude-3.5-sonnet"). */
  readonly modelName: string | null;

  /**
   * Execute a benchmark task.
   * @param task - The task definition
   * @param workspacePath - Path to the isolated sandbox workspace
   * @param emitter - Callback to emit trajectory events for every observable action
   * @returns Execution result
   */
  executeTask(
    task: BenchmarkTask,
    workspacePath: string,
    emitter: TrajectoryEmitter,
  ): Promise<TaskExecutionResult>;

  /**
   * Send a message to the agent (e.g., an intervention).
   * Returns the agent's response.
   */
  sendMessage(message: string): Promise<AgentMessage>;

  /**
   * Execute a tool on behalf of the agent.
   */
  executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolExecution>;

  /**
   * Get metadata about the current session.
   */
  getSessionMetadata(): SessionMetadata;

  /**
   * Terminate the agent session.
   */
  terminate(): Promise<void>;
}
