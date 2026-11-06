import fs from "node:fs";

/**
 * Query cache: computation memory at the level of a whole answered task, not
 * just per-analysis statistics.
 *
 * PlannerMemory (memory.ts) remembers the *economics* of running an analysis
 * (its cost, its measured effect on uncertainty). This module remembers the
 * *result* of a previously answered task, so that re-asking the same
 * question against the same evidence is free instead of re-running the
 * planner loop.
 *
 * A cache entry is addressed by:
 *   task type + task target + knowledge-store revision + engine fingerprint
 *
 * The revision ties a result to the exact repository state it was computed
 * against (git sha, or content hash when git is unavailable). If the
 * revision changes, every entry for that revision is simply unreachable —
 * this is not file-level incrementalism (the engine still recomputes from
 * scratch on revision change), but it does mean repeated queries against an
 * unchanged repository never re-run the planner, and it gives every stored
 * result an explicit, checkable staleness condition instead of an implicit
 * one.
 *
 * The engine fingerprint guards against a second, quieter kind of
 * staleness: the result is only reusable if the code that produced it is
 * still the code that would produce it today. Bump ENGINE_FINGERPRINT when a
 * task's evaluate/uncertainty/risk function, or an analysis it depends on,
 * changes in a way that could change the answer for the same evidence.
 */

export const ENGINE_FINGERPRINT = "1";

export interface CacheEntry {
  taskType: string;
  target: string;
  revision: string;
  fingerprint: string;
  /** the cached PlanOutcome, serialized */
  outcome: unknown;
  /**
   * The verification record attached to this outcome, if verification was
   * ever run for it. Stored separately from `outcome` (rather than folded
   * into it) because verification runs *after* the planner produces
   * `outcome` (see engine.ts): a cache entry can exist with `outcome` set
   * and `verification` still undefined, briefly, between those two steps,
   * and a later hit should re-attach verification rather than treat the
   * entry as incomplete.
   */
  verification?: unknown;
  /** wall-clock ms the original computation cost; what this entry saves on a hit */
  computedCostMs: number;
  computedAt: string;
  hits: number;
  lastHitAt: string | null;
}

export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
  /** sum of computedCostMs across all hits: wall-clock time this cache has saved */
  msSaved: number;
}

export class QueryCache {
  private table = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  private key(taskType: string, target: string, revision: string, fingerprint: string): string {
    return `${taskType}::${target}::${revision}::${fingerprint}`;
  }

  get(taskType: string, target: string, revision: string, fingerprint = ENGINE_FINGERPRINT): CacheEntry | null {
    const entry = this.table.get(this.key(taskType, target, revision, fingerprint));
    if (!entry) {
      this.misses += 1;
      return null;
    }
    entry.hits += 1;
    entry.lastHitAt = new Date().toISOString();
    this.hits += 1;
    return entry;
  }

  /**
   * Like `get`, but does not affect hit/miss stats or `lastHitAt`. Used by
   * the engine to check for an already-attached verification record on a
   * cache hit it has already counted via the planner's own `get()` call —
   * counting it a second time would double the reported hit rate for a
   * single logical query.
   */
  peek(taskType: string, target: string, revision: string, fingerprint = ENGINE_FINGERPRINT): CacheEntry | null {
    return this.table.get(this.key(taskType, target, revision, fingerprint)) ?? null;
  }

  /**
   * Attach a verification record to an already-cached entry. No-op if the
   * entry doesn't exist (e.g. `queryCache` was null when the primary
   * outcome was computed, so nothing was ever cached to attach to).
   */
  attachVerification(
    taskType: string,
    target: string,
    revision: string,
    verification: unknown,
    fingerprint = ENGINE_FINGERPRINT,
  ): void {
    const entry = this.table.get(this.key(taskType, target, revision, fingerprint));
    if (entry) entry.verification = verification;
  }

  set(
    taskType: string,
    target: string,
    revision: string,
    outcome: unknown,
    computedCostMs: number,
    fingerprint = ENGINE_FINGERPRINT,
  ): void {
    this.table.set(this.key(taskType, target, revision, fingerprint), {
      taskType,
      target,
      revision,
      fingerprint,
      outcome,
      computedCostMs,
      computedAt: new Date().toISOString(),
      hits: 0,
      lastHitAt: null,
    });
  }

  /** Drop every entry for a revision that is no longer current (e.g. after Engine.refresh()). */
  invalidateRevision(revision: string): number {
    let removed = 0;
    for (const [key, entry] of this.table) {
      if (entry.revision === revision) {
        this.table.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  stats(): CacheStats {
    let msSaved = 0;
    for (const entry of this.table.values()) msSaved += entry.hits * entry.computedCostMs;
    return { hits: this.hits, misses: this.misses, entries: this.table.size, msSaved };
  }

  save(file: string): void {
    fs.writeFileSync(file, JSON.stringify([...this.table.values()], null, 2));
  }

  static load(file: string): QueryCache {
    const cache = new QueryCache();
    if (!fs.existsSync(file)) return cache;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as CacheEntry[];
    for (const entry of raw) {
      cache.table.set(cache.key(entry.taskType, entry.target, entry.revision, entry.fingerprint), entry);
    }
    return cache;
  }
}
