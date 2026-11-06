/**
 * Repository observation module.
 *
 * Captures initial/final git state, git diff, files modified/created/deleted/read,
 * LOC changes, test results, build status, and lint status for every task session.
 * Secrets are automatically redacted before recording.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { RepositoryObservation, TestRunResult, BuildResult, LintResult } from "../types.js";
import { Redactor } from "../trajectory/redactor.js";

export class RepoObserver {
  private readonly redactor: Redactor;

  constructor() {
    this.redactor = new Redactor();
  }

  /**
   * Get current Git HEAD commit hash in workspace.
   */
  getGitCommitHash(workspacePath: string): string | null {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Get full git diff of workspace compared to HEAD (or initial commit).
   */
  getGitDiff(workspacePath: string): string | null {
    try {
      const rawDiff = execFileSync("git", ["diff", "HEAD"], {
        cwd: workspacePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return this.redactor.redactString(rawDiff);
    } catch {
      try {
        const rawDiff = execFileSync("git", ["diff"], {
          cwd: workspacePath,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return this.redactor.redactString(rawDiff);
      } catch {
        return null;
      }
    }
  }

  /**
   * Compute full repository observation for a workspace session.
   */
  observeWorkspace(
    workspacePath: string,
    initialCommit: string | null,
    filesRead: string[] = [],
    commandsExecuted: string[] = [],
    testResult: TestRunResult | null = null,
    buildResult: BuildResult | null = null,
    lintResult: LintResult | null = null,
  ): RepositoryObservation {
    const finalCommit = this.getGitCommitHash(workspacePath);
    const gitDiff = this.getGitDiff(workspacePath);

    const filesChanged: string[] = [];
    const filesCreated: string[] = [];
    const filesDeleted: string[] = [];
    const testFilesChanged: string[] = [];
    let linesAdded = 0;
    let linesRemoved = 0;

    try {
      const statusOutput = execFileSync("git", ["status", "--porcelain"], {
        cwd: workspacePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

      const lines = statusOutput.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const status = line.slice(0, 2).trim();
        const file = line.slice(3).trim();
        if (!file) continue;

        if (status.includes("M")) filesChanged.push(file);
        if (status.includes("A") || status.includes("??")) filesCreated.push(file);
        if (status.includes("D")) filesDeleted.push(file);

        if (file.includes(".test.") || file.includes(".spec.") || file.includes("test/")) {
          testFilesChanged.push(file);
        }
      }
    } catch {
      // Non-git fallback
    }

    if (gitDiff) {
      for (const line of gitDiff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
        if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
      }
    }

    return {
      initial_commit: initialCommit,
      final_commit: finalCommit,
      git_diff: gitDiff,
      files_changed: Array.from(new Set(filesChanged)),
      files_created: Array.from(new Set(filesCreated)),
      files_deleted: Array.from(new Set(filesDeleted)),
      files_read: Array.from(new Set(filesRead)),
      lines_added: linesAdded,
      lines_removed: linesRemoved,
      test_files_changed: Array.from(new Set(testFilesChanged)),
      commands_executed: commandsExecuted.map((c) => this.redactor.redactString(c)),
      test_results: testResult,
      build_results: buildResult,
      lint_results: lintResult,
    };
  }
}
