import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore, StoreSnapshot } from "./store.js";

// This package is ESM ("type": "module"), so `node:sqlite` — which some
// Node versions only expose in a form easiest to reach via `require` — is
// loaded through a scoped require rather than a static/dynamic `import`.
// This also lets us catch "module not found" synchronously and fall back.
const nodeRequire = createRequire(import.meta.url);

/**
 * Persistent fact store.
 *
 * Root cause this fixes: `Engine` used to rebuild a full `ts.Program` and a
 * blank `KnowledgeStore` from scratch on every process invocation, so a
 * second query against an *unchanged* file cost the same as the first. This
 * cache makes a repeated query against unchanged files a disk lookup instead
 * of a recompute: on load, any file whose content hash still matches the
 * cached hash keeps its previously derived entities/relations/evidence; only
 * files that actually changed are invalidated and re-analyzed.
 *
 * Backend: SQLite via the Node built-in `node:sqlite` module (no external
 * dependency, no native compile step). Node versions that don't ship it yet
 * (pre-22.5, or built without the experimental flag) fall back to a single
 * JSON file with the same on-disk contract, so caching still works — just
 * without SQLite's crash-safety guarantees.
 */

const CACHE_SCHEMA_VERSION = 1;

function cacheDirFor(explicit?: string | null): string {
  if (explicit) return explicit;
  if (process.env.SIE_CACHE_DIR) return process.env.SIE_CACHE_DIR;
  return path.join(os.homedir(), ".sie-cache");
}

function keyFor(root: string): string {
  return createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 16);
}

interface SqliteLike {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  close(): void;
}

/** node:sqlite backend. Schema: a single key/value table, one row per repository. */
function openSqlite(file: string): SqliteLike {
  // Loaded dynamically so that environments without node:sqlite never touch
  // this path at parse time, and typed as `any` so this compiles regardless
  // of whether the installed @types/node version declares this module.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { DatabaseSync } = nodeRequire("node:sqlite") as any;
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_cache (
      repo_key TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      saved_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    )
  `);
  return {
    get(key: string) {
      const row = db
        .prepare("SELECT snapshot_json, schema_version FROM fact_cache WHERE repo_key = ?")
        .get(key) as { snapshot_json: string; schema_version: number } | undefined;
      if (!row || row.schema_version !== CACHE_SCHEMA_VERSION) return undefined;
      return row.snapshot_json;
    },
    set(key: string, value: string) {
      db.prepare(
        `INSERT INTO fact_cache (repo_key, schema_version, saved_at, snapshot_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_key) DO UPDATE SET
           schema_version = excluded.schema_version,
           saved_at = excluded.saved_at,
           snapshot_json = excluded.snapshot_json`,
      ).run(key, CACHE_SCHEMA_VERSION, new Date().toISOString(), value);
    },
    close() {
      db.close();
    },
  };
}

/** Fallback backend for Node runtimes without node:sqlite: one JSON file per repo. */
function openJsonFile(file: string): SqliteLike {
  return {
    get(key: string) {
      if (!fs.existsSync(file)) return undefined;
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
          repoKey: string;
          schemaVersion: number;
          snapshotJson: string;
        };
        if (raw.repoKey !== key || raw.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined;
        return raw.snapshotJson;
      } catch {
        return undefined;
      }
    },
    set(key: string, value: string) {
      fs.writeFileSync(
        file,
        JSON.stringify({ repoKey: key, schemaVersion: CACHE_SCHEMA_VERSION, snapshotJson: value }),
      );
    },
    close() {
      /* no-op */
    },
  };
}

let sqliteAvailable: boolean | null = null;
function hasSqlite(): boolean {
  if (sqliteAvailable !== null) return sqliteAvailable;
  try {
    nodeRequire("node:sqlite");
    sqliteAvailable = true;
  } catch {
    sqliteAvailable = false;
  }
  return sqliteAvailable;
}

export interface FactCacheOptions {
  /** Override the cache directory. Defaults to $SIE_CACHE_DIR or ~/.sie-cache */
  cacheDir?: string | null;
}

export class FactCache {
  private backend: SqliteLike | null = null;
  private readonly dir: string;

  constructor(options: FactCacheOptions = {}) {
    this.dir = cacheDirFor(options.cacheDir);
  }

  private ensureBackend(): SqliteLike {
    if (this.backend) return this.backend;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, hasSqlite() ? "facts.db" : "facts.json.d");
    this.backend = hasSqlite() ? openSqlite(file) : openJsonFile(path.join(this.dir, "facts.json"));
    return this.backend;
  }

  /** Load the cached snapshot for a repository root, or null if none/corrupt. */
  load(root: string): StoreSnapshot | null {
    try {
      const raw = this.ensureBackend().get(keyFor(root));
      if (!raw) return null;
      return JSON.parse(raw) as StoreSnapshot;
    } catch {
      return null;
    }
  }

  save(root: string, snapshot: StoreSnapshot): void {
    try {
      this.ensureBackend().set(keyFor(root), JSON.stringify(snapshot));
    } catch {
      // Persistence is best-effort: a failed write should never fail the
      // caller's actual task.
    }
  }

  close(): void {
    this.backend?.close();
    this.backend = null;
  }
}

/**
 * Restore what can be reused from `cache` into `store`, given the current
 * on-disk content hash of every file. Returns the set of files that were
 * *not* restored (missing from the cache, or hash-mismatched) — callers
 * should treat these as needing (re-)analysis, exactly like `refresh()`.
 */
export function hydrateFromCache(
  store: KnowledgeStore,
  cache: FactCache,
  currentFileHashes: Map<string, string>,
): { restoredFiles: number; staleFiles: string[] } {
  const snapshot = cache.load(store.repositoryRoot);
  if (!snapshot) return { restoredFiles: 0, staleFiles: [...currentFileHashes.keys()] };

  store.loadSnapshot(snapshot);
  const stale = store.staleFiles(currentFileHashes);
  for (const file of stale) store.invalidateFile(file);
  const restored = snapshot.fileHashes.length - stale.length;
  return { restoredFiles: Math.max(0, restored), staleFiles: stale };
}
