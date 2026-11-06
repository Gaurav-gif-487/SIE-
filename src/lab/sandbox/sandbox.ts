/**
 * Sandbox environment for task execution.
 *
 * Every task executes inside an isolated workspace:
 *   clean repo snapshot → task assigned → agent executes → trajectory recorded → tests executed → result collected → workspace archived
 *
 * Since Docker is unavailable, this implements the clearly marked local fallback sandbox:
 *   `[LOCAL_SANDBOX]`
 *
 * Direct execution of arbitrary agent commands on the host is disallowed unless `unsafe_mode` is explicitly set to true.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { SandboxConfig, SandboxMode } from "../types.js";

export interface WorkspaceSession {
  workspacePath: string;
  archivePath: string | null;
  mode: SandboxMode;
  isUnsafe: boolean;
  cleanUp: () => void;
}

export class Sandbox {
  private readonly config: SandboxConfig;

  constructor(config?: Partial<SandboxConfig>) {
    this.config = {
      mode: "local",
      unsafe_mode: config?.unsafe_mode ?? false,
      workspace_root: config?.workspace_root ?? path.join(os.tmpdir(), "agent-mirror-sandboxes"),
      archive: config?.archive ?? true,
    };

    fs.mkdirSync(this.config.workspace_root, { recursive: true });
  }

  get mode(): SandboxMode {
    return this.config.mode;
  }

  get isUnsafe(): boolean {
    return this.config.unsafe_mode;
  }

  /**
   * Create a clean, isolated workspace initialized with the task repository.
   *
   * @param taskRepoPath - Source path of the fixture repository
   * @param taskId - ID of the task being executed
   * @param sessionId - Session ID
   */
  createWorkspace(taskRepoPath: string, taskId: string, sessionId: string): WorkspaceSession {
    const timestamp = Date.now();
    const sandboxDirName = `ws_${taskId}_${sessionId.slice(0, 8)}_${timestamp}`;
    const workspacePath = path.join(this.config.workspace_root, sandboxDirName);

    // Ensure clean workspace directory
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
    fs.mkdirSync(workspacePath, { recursive: true });

    // Copy repository template to isolated workspace
    if (fs.existsSync(taskRepoPath)) {
      fs.cpSync(taskRepoPath, workspacePath, { recursive: true });
    }

    // Initialize git repository inside sandbox if git is available and not already a git repo
    const gitDir = path.join(workspacePath, ".git");
    if (!fs.existsSync(gitDir)) {
      try {
        execFileSync("git", ["init"], { cwd: workspacePath, stdio: "ignore" });
        execFileSync("git", ["config", "user.name", "Agent Mirror Sandbox"], { cwd: workspacePath, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "sandbox@agent-mirror.local"], { cwd: workspacePath, stdio: "ignore" });
        execFileSync("git", ["add", "-A"], { cwd: workspacePath, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "Initial sandbox snapshot"], { cwd: workspacePath, stdio: "ignore" });
      } catch {
        // Git initialization fallback if git command fails in env
      }
    }

    // Mark sandbox as local fallback explicitly
    const markerFile = path.join(workspacePath, ".sandbox_metadata.json");
    fs.writeFileSync(
      markerFile,
      JSON.stringify(
        {
          mode: "local",
          label: "[LOCAL_SANDBOX]",
          created_at: new Date().toISOString(),
          task_id: taskId,
          session_id: sessionId,
          unsafe_mode: this.config.unsafe_mode,
        },
        null,
        2,
      ),
    );

    let archivePath: string | null = null;

    const cleanUp = () => {
      if (this.config.archive) {
        const archivesDir = path.join(this.config.workspace_root, "archives");
        fs.mkdirSync(archivesDir, { recursive: true });
        archivePath = path.join(archivesDir, `${sandboxDirName}.json`);
        // Store metadata archive
        try {
          const files = this.listFiles(workspacePath);
          fs.writeFileSync(
            archivePath,
            JSON.stringify(
              {
                sandboxDirName,
                taskId,
                sessionId,
                archivedAt: new Date().toISOString(),
                fileCount: files.length,
              },
              null,
              2,
            ),
          );
        } catch {
          // archive silent catch
        }
      }
      fs.rmSync(workspacePath, { recursive: true, force: true });
    };

    return {
      workspacePath,
      archivePath,
      mode: "local",
      isUnsafe: this.config.unsafe_mode,
      cleanUp,
    };
  }

  /**
   * Execute a command within the sandbox workspace.
   * Host command execution requires explicit unsafe_mode or restricted command list.
   */
  executeCommand(
    workspacePath: string,
    command: string,
    args: string[] = [],
    env: Record<string, string> = {},
  ): { stdout: string; stderr: string; exitCode: number; durationMs: number } {
    const safeCommands = new Set(["npm", "npx", "node", "git", "vitest", "tsc", "eslint"]);
    const cmdBinary = command.split(" ")[0]?.toLowerCase() ?? "";

    if (!this.config.unsafe_mode && !safeCommands.has(cmdBinary)) {
      return {
        stdout: "",
        stderr: `[LOCAL_SANDBOX] Command '${command}' blocked: Arbitrary agent command execution on host is forbidden without explicit unsafe_mode = true.`,
        exitCode: 126,
        durationMs: 0,
      };
    }

    const t0 = Date.now();
    try {
      const res = spawnSync(command, args, {
        cwd: workspacePath,
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: 60000,
        shell: true,
      });

      return {
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        exitCode: res.status ?? (res.error ? 1 : 0),
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        stdout: "",
        stderr: (err as Error).message,
        exitCode: 1,
        durationMs: Date.now() - t0,
      };
    }
  }

  private listFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.listFiles(full));
      } else {
        results.push(full);
      }
    }
    return results;
  }
}
