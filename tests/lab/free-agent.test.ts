/**
 * Tests for FreeLLMAgentAdapter.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { FreeLLMAgentAdapter } from "../../src/lab/adapters/free-agent.js";
import type { BenchmarkTask } from "../../src/lab/types.js";

const SAMPLE_TASK: BenchmarkTask = {
  id: "test-task-free-001",
  description: "Fix array sum bug",
  repository: "fixtures/bug-fix-off-by-one",
  expected_tests: ["math.test.js"],
  difficulty: "easy",
  category: "bug_fix",
  relevant_files: ["src/math.js"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FreeLLMAgentAdapter", () => {
  it("initializes with real execution_mode", () => {
    const adapter = new FreeLLMAgentAdapter({ provider: "github-models" });
    expect(adapter.executionMode).toBe("real");
    expect(adapter.modelProvider).toBe("github-models");
    expect(adapter.getSessionMetadata().execution_mode).toBe("real");
  });

  it("records the model reply and reports success when the provider answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: { content: "patched" } }), { status: 200 })),
    );
    const adapter = new FreeLLMAgentAdapter({ provider: "ollama" });
    const events: any[] = [];
    const result = await adapter.executeTask(SAMPLE_TASK, "/tmp/ws", (e) => events.push(e));

    expect(result.success).toBe(true);
    expect(result.final_message).toBe("patched");
    expect(result.files_changed).toEqual([]);
    expect(events.map((e) => e.event_type)).toEqual(["task_started", "agent_message", "task_finished"]);
    expect(events.every((e) => e.execution_mode === "real")).toBe(true);
  });

  it("reports failure instead of success when the provider call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const adapter = new FreeLLMAgentAdapter({ provider: "ollama" });
    const events: any[] = [];
    const result = await adapter.executeTask(SAMPLE_TASK, "/tmp/ws", (e) => events.push(e));

    expect(result.success).toBe(false);
    expect(events.at(-1).payload.success).toBe(false);
  });

  it("fails without a GitHub token", async () => {
    const saved = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    try {
      const adapter = new FreeLLMAgentAdapter({ provider: "github-models" });
      const result = await adapter.executeTask(SAMPLE_TASK, "/tmp/ws", () => {});
      expect(result.success).toBe(false);
      expect(result.final_message).toContain("GITHUB_TOKEN");
    } finally {
      if (saved !== undefined) process.env["GITHUB_TOKEN"] = saved;
    }
  });
});
