/**
 * Hosted/local LLM adapter.
 *
 * Sends the task description to a chat-completion endpoint and records the
 * reply as trajectory events. Supported providers:
 *   - "github-models": GitHub Models inference endpoint (needs GITHUB_TOKEN)
 *   - "ollama":        a local Ollama server (default http://localhost:11434)
 *
 * This adapter only talks to the model. It does not apply edits to the
 * workspace or run tests, so `files_changed` is always empty and `success`
 * means "the provider returned a reply", not "the task was solved".
 */

import type { BenchmarkTask } from "../types.js";
import { generateSessionId } from "../types.js";
import type {
  AgentAdapter,
  AgentMessage,
  SessionMetadata,
  TaskExecutionResult,
  ToolExecution,
  TrajectoryEmitter,
} from "./types.js";

export type FreeProvider = "github-models" | "ollama";

export interface FreeAgentConfig {
  provider?: FreeProvider;
  modelName?: string;
  apiKey?: string;
  ollamaBaseUrl?: string;
}

const GITHUB_MODELS_URL = "https://models.inference.ai.azure.com/chat/completions";

export class FreeLLMAgentAdapter implements AgentAdapter {
  readonly adapterName = "FreeLLMAgentAdapter";
  readonly executionMode = "real" as const;
  readonly modelProvider: string;
  readonly modelName: string;
  private readonly apiKey: string;
  private readonly ollamaBaseUrl: string;
  private readonly sessionId = generateSessionId();
  private readonly startedAt = new Date().toISOString();

  constructor(config?: FreeAgentConfig) {
    this.modelProvider = config?.provider ?? "github-models";
    this.modelName =
      config?.modelName ?? (this.modelProvider === "github-models" ? "gpt-4o-mini" : "qwen2.5-coder");
    this.apiKey = config?.apiKey ?? process.env["GITHUB_TOKEN"] ?? "";
    this.ollamaBaseUrl = config?.ollamaBaseUrl ?? "http://localhost:11434";
  }

  getSessionMetadata(): SessionMetadata {
    return {
      session_id: this.sessionId,
      agent_name: this.adapterName,
      model_provider: this.modelProvider,
      model_name: this.modelName,
      execution_mode: this.executionMode,
      started_at: this.startedAt,
      capabilities: ["chat"],
    };
  }

  async executeTask(
    task: BenchmarkTask,
    _workspacePath: string,
    onEvent: TrajectoryEmitter,
  ): Promise<TaskExecutionResult> {
    const sessionId = generateSessionId();
    const t0 = Date.now();
    const base = {
      task_id: task.id,
      session_id: sessionId,
      actor: "system" as const,
      execution_mode: "real" as const,
      repository_state: null,
    };

    onEvent({
      ...base,
      timestamp: new Date().toISOString(),
      event_type: "task_started",
      payload: { description: task.description },
    });

    const systemPrompt = `You are a coding assistant solving the task: ${task.description}. Reply concisely with the code changes needed.`;
    const userPrompt =
      `Task repository: ${task.repository}\n` +
      `Relevant files: ${task.relevant_files.join(", ")}\n` +
      `Expected tests: ${task.expected_tests.join(", ")}`;

    let reply: string | null = null;
    let error: string | null = null;
    try {
      reply = await this.queryLLM(systemPrompt, userPrompt);
    } catch (err) {
      error = (err as Error).message;
    }

    if (reply !== null) {
      onEvent({
        ...base,
        actor: "agent",
        timestamp: new Date().toISOString(),
        event_type: "agent_message",
        payload: { content: reply },
      });
    }

    onEvent({
      ...base,
      timestamp: new Date().toISOString(),
      event_type: "task_finished",
      payload: { success: reply !== null, error },
    });

    return {
      session_id: sessionId,
      success: reply !== null,
      final_message: reply ?? error,
      duration_ms: Date.now() - t0,
      files_changed: [],
      commands_executed: [],
      test_runs: 0,
      retry_count: 0,
    };
  }

  async sendMessage(message: string): Promise<AgentMessage> {
    const reply = await this.queryLLM("You are a helpful coding assistant.", message);
    return { role: "assistant", content: reply, timestamp: new Date().toISOString() };
  }

  async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolExecution> {
    return {
      tool_name: toolName,
      arguments: args,
      result: { error: "FreeLLMAgentAdapter does not execute tools" },
      success: false,
      duration_ms: 0,
      timestamp: new Date().toISOString(),
    };
  }

  async terminate(): Promise<void> {}

  /** Returns the model's reply, or throws if the provider call fails. */
  private async queryLLM(systemPrompt: string, userPrompt: string): Promise<string> {
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    if (this.modelProvider === "github-models") {
      if (!this.apiKey) throw new Error("GITHUB_TOKEN is not set");
      const res = await fetch(GITHUB_MODELS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ messages, model: this.modelName, temperature: 0.2 }),
      });
      if (!res.ok) throw new Error(`GitHub Models error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("GitHub Models returned no content");
      return content;
    }

    if (this.modelProvider === "ollama") {
      const res = await fetch(`${this.ollamaBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.modelName, messages, stream: false }),
      });
      if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { message?: { content?: string } };
      const content = data.message?.content;
      if (!content) throw new Error("Ollama returned no content");
      return content;
    }

    throw new Error(`Unsupported provider: ${this.modelProvider}`);
  }
}
