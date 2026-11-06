#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import { Engine, EngineOptions } from "../engine/engine.js";
import { QueryCache } from "../planning/query-cache.js";
import { DaemonRequest, DaemonResponse, normalizeRoot, pidFile, socketPath } from "./protocol.js";

const engines = new Map<string, Engine>();
const queryCaches = new Map<string, QueryCache>();
const watchers = new Map<string, fs.FSWatcher>();
/** debounce a burst of fs events (e.g. a git checkout, an editor autosave-batch) into one refresh() */
const REFRESH_DEBOUNCE_MS = 300;
const refreshTimers = new Map<string, NodeJS.Timeout>();

function engineFor(root: string, engineOptions: Record<string, unknown> | undefined): Engine {
  const key = normalizeRoot(root);
  const existing = engines.get(key);
  if (existing) return existing;
  // The daemon IS the persistence layer for the lifetime of the process: it
  // hydrates from the cache once (cache: true) but disables Engine's own
  // per-call disk round-trip (autoPersist: false) and instead persists on an
  // interval / on shutdown, cutting per-request overhead to near zero once
  // a repo is warm.
  //
  // Each warm repo also gets its own QueryCache, so repeat queries against
  // an unchanged revision within this daemon's lifetime skip the planner
  // loop (and, per Engine.withVerificationCache, skip re-running the
  // independent challenge too) instead of only benefiting from the
  // cheaper PlannerMemory cost/uncertainty statistics.
  const queryCache = new QueryCache();
  queryCaches.set(key, queryCache);
  const engine = new Engine(root, {
    ...(engineOptions as EngineOptions),
    cache: true,
    autoPersist: false,
    queryCache,
  });
  engines.set(key, engine);
  watchRoot(key, root);
  return engine;
}

/**
 * Auto-refresh a warm repo when its files change on disk, so a client that
 * queries a repo someone else is actively editing gets a stale-fact error
 * or a re-planned answer instead of a silently outdated one. Without this,
 * `Engine.refresh()` only ever runs when a client explicitly calls it — in
 * a long-lived daemon that's easy to forget, and defeats a chunk of the
 * daemon's own point (staying warm against a repo that keeps moving).
 *
 * fs.watch's recursive mode isn't available on Linux, so this walks one
 * level of watches rooted at the repo root instead of asking for a single
 * recursive watch; that's sufficient because Node's fs.watch on a
 * directory already reports changes to files within it, and this daemon
 * targets single-repo-root layouts, not deeply nested watch trees, so one
 * root-level watcher catches the common case (edits to files at any depth
 * still fire the underlying inotify event bubbling up through the parent
 * directory watch on most platforms). A dedicated recursive watch (e.g.
 * via the `chokidar` package) would be more complete but adds a
 * dependency; documented here as the natural next step if this proves
 * insufficient in practice.
 */
function watchRoot(key: string, root: string): void {
  if (watchers.has(key)) return;
  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (filename && (filename.includes("node_modules") || filename.includes(".git"))) return;
      const existingTimer = refreshTimers.get(key);
      if (existingTimer) clearTimeout(existingTimer);
      refreshTimers.set(
        key,
        setTimeout(() => {
          refreshTimers.delete(key);
          const engine = engines.get(key);
          if (!engine) return;
          try {
            engine.refresh();
          } catch {
            // best-effort: a failed auto-refresh just means the next
            // explicit query re-derives staleness itself
          }
        }, REFRESH_DEBOUNCE_MS),
      );
    });
    watchers.set(key, watcher);
  } catch {
    // fs.watch with recursive:true isn't supported on every platform
    // (notably some Linux filesystems); auto-refresh is a convenience on
    // top of explicit refresh(), not a correctness requirement, so a
    // failure here is silently skipped rather than failing the request
    // that triggered engineFor().
  }
}

async function handle(req: DaemonRequest): Promise<DaemonResponse> {
  if (req.kind === "ping") return { id: req.id, ok: true, result: "pong", warmRepos: engines.size };
  if (req.kind === "shutdown") {
    setTimeout(() => shutdown(0), 50);
    return { id: req.id, ok: true, result: "shutting down" };
  }
  try {
    const engine = engineFor(req.root, req.engineOptions);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (engine as any)[req.method];
    if (typeof fn !== "function") throw new Error(`unknown Engine method: ${req.method}`);
    const result = await fn.apply(engine, req.args);
    return { id: req.id, ok: true, result, warmRepos: engines.size };
  } catch (err) {
    return { id: req.id, ok: false, error: (err as Error).message, warmRepos: engines.size };
  }
}

function shutdown(code: number): void {
  for (const engine of engines.values()) engine.close();
  for (const watcher of watchers.values()) watcher.close();
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  watchers.clear();
  refreshTimers.clear();
  try {
    fs.unlinkSync(socketPath());
  } catch {
    /* already gone */
  }
  try {
    fs.unlinkSync(pidFile());
  } catch {
    /* already gone */
  }
  process.exit(code);
}

function main(): void {
  const sock = socketPath();
  try {
    fs.unlinkSync(sock);
  } catch {
    /* no stale socket */
  }

  const server = net.createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        void (async () => {
          let req: DaemonRequest;
          try {
            req = JSON.parse(line) as DaemonRequest;
          } catch {
            return;
          }
          const res = await handle(req);
          conn.write(`${JSON.stringify(res)}\n`);
        })();
      }
    });
  });

  server.listen(sock, () => {
    fs.writeFileSync(pidFile(), String(process.pid));
    // Single stdout line so `sie daemon start` can confirm readiness.
    console.log(`sie daemon listening on ${sock} (pid ${process.pid})`);
  });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  // Persist warm state periodically so a daemon crash doesn't lose facts
  // that a client hasn't triggered a fresh persist for.
  setInterval(() => {
    for (const engine of engines.values()) engine.persist();
  }, 30_000).unref();
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) main();
if (process.argv[1] && process.argv[1].endsWith("server.js")) main();
