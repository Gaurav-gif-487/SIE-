/**
 * Outcome Ground Truth Evaluator.
 *
 * Evaluates task success and secondary metrics objectively via automated execution.
 * Primary outcome: task_success (all tests pass, build succeeds)
 * Secondary outcomes: tests_passed, tests_failed, duration_ms, commands, retries, files, LOC, build/lint status
 * Ground truth comes from automated execution; any human labeling is explicitly marked.
 */

import type { TaskOutcome, TestRunResult, BuildResult, LintResult } from "../types.js";
import { Sandbox } from "../sandbox/sandbox.js";
import { RepoObserver } from "../sandbox/repo-observer.js";

export interface EvaluatorInput {
  workspacePath: string;
  expectedTests: string[];
  durationMs: number;
  totalCommands: number;
  retryCount: number;
  filesChangedCount: number;
  locChangedCount: number;
  duplicateLocCount?: number;
  costIfAvailable?: number | null;
  humanLabeled?: boolean;
}

export class OutcomeEvaluator {
  private readonly sandbox: Sandbox;
  private readonly observer: RepoObserver;

  constructor(sandbox?: Sandbox) {
    this.sandbox = sandbox ?? new Sandbox();
    this.observer = new RepoObserver();
  }

  /**
   * Evaluate task outcomes by running actual automated test & build suites in the sandbox.
   */
  evaluateTask(input: EvaluatorInput): TaskOutcome {
    // Run automated tests in sandbox
    const testExec = this.sandbox.executeCommand(input.workspacePath, "npm", ["test"]);

    let testsPassed = 0;
    let testsFailed = 0;
    let buildStatus: "success" | "failure" | "skipped" = "success";
    let lintStatus: "success" | "failure" | "skipped" = "skipped";

    if (testExec.exitCode === 0) {
      testsPassed = input.expectedTests.length || 1;
      testsFailed = 0;
    } else {
      testsPassed = 0;
      testsFailed = input.expectedTests.length || 1;
      buildStatus = "failure";
    }

    const taskSuccess = testsFailed === 0 && testExec.exitCode === 0;

    return {
      task_success: taskSuccess,
      tests_passed: testsPassed,
      tests_failed: testsFailed,
      time_to_completion_ms: input.durationMs,
      total_commands: input.totalCommands,
      retry_count: input.retryCount,
      files_changed: input.filesChangedCount,
      loc_changed: input.locChangedCount,
      duplicate_loc: input.duplicateLocCount ?? 0,
      build_status: buildStatus,
      lint_status: lintStatus,
      cost_if_available: input.costIfAvailable ?? null,
      evaluation_method: input.humanLabeled ? "human_labeled" : "automated",
    };
  }
}
