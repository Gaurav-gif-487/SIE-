import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Long-running daemon.
 *
 * Root cause this fixes: every CLI invocation used to construct a fresh
 * `Engine`, which rebuilds a full `ts.Program` (parse + bind + typecheck the
 * whole repository) before it can answer anything. That cost was paid once
 * *per query*, not once per session. The daemon holds warm `Engine`
 * instances (one per repository root) in memory across many CLI
 * invocations, so only the first query after a daemon start (or after files
 * actually changed) pays the cold-start cost — every later query in the same
 * session is close to free, the same trade every real code-intelligence
 * daemon (tsserver, rust-analyzer) makes.
 *
 * This is a request/response JSON-line protocol over a Unix domain socket
 * (named pipe on Windows), scoped to a single OS user. It is a convenience
 * layer only: every command still works without the daemon running, by
 * falling back to an in-process `Engine`.
 */

export interface EngineMethodRequest {
  id: number;
  kind: "call";
  root: string;
  /** Engine constructor options, minus root */
  engineOptions?: Record<string, unknown>;
  /** name of an Engine instance method to invoke */
  method: string;
  args: unknown[];
}

export interface PingRequest {
  id: number;
  kind: "ping";
}

export interface ShutdownRequest {
  id: number;
  kind: "shutdown";
}

export type DaemonRequest = EngineMethodRequest | PingRequest | ShutdownRequest;

export interface DaemonResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** how many repositories the daemon currently holds warm, for status/debugging */
  warmRepos?: number;
}

export function socketPath(): string {
  if (process.env.SIE_DAEMON_SOCKET) return process.env.SIE_DAEMON_SOCKET;
  const user = os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "_");
  const name = `sie-daemon-${user}.sock`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), name);
}

export function pidFile(): string {
  return path.join(os.tmpdir(), `sie-daemon-${os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "_")}.pid`);
}

export function normalizeRoot(root: string): string {
  return path.resolve(root);
}

export function repoKey(root: string): string {
  return createHash("sha1").update(normalizeRoot(root)).digest("hex").slice(0, 16);
}
