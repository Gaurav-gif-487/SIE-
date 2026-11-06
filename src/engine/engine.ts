import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../knowledge/store.js";
import { FactCache, hydrateFromCache } from "../knowledge/persist.js";
import { AnalysisContext, createContext, analysisByName, applicableAnalysisNames } from "../analyses/library.js";
import { Planner, PlanOutcome, PlannerMode, PlannerOptions } from "../planning/planner.js";
import { PlannerMemory } from "../planning/memory.js";
import { QueryCache, ENGINE_FINGERPRINT } from "../planning/query-cache.js";
import { FindCallersResult, findCallersTask } from "../tasks/find-callers.js";
import { FindCalleesResult, findCalleesTask } from "../tasks/find-callees.js";
import {
  VerificationRecord,
  VerifiedPlanOutcome,
  VerifyOptions,
  classifyFinalStatus,
  verifyFindCallees,
  verifyFindCallers,
  verifyFindReferences,
  verifyImpactOfChange,
  verifyModuleDependents,
  verifyWhichTestsExercise,
} from "../verification/verify.js";
import {
  FindReferencesResult,
  ImpactOfChangeResult,
  ImportImpactResult,
  ModuleDependentsResult,
  WhichTestsResult,
  WhyChangedResult,
  findReferencesTask,
  impactOfChangeTask,
  importImpactTask,
  moduleDependentsTask,
  whichTestsExerciseTask,
  whyDidChangeTask,
} from "../tasks/queries.js";
import { crystallizationLevel, CrystallizationReport } from "../crystallization/levels.js";
import { RepoOverviewResult, repoOverview } from "../tasks/repo-overview.js";
import { detectRevision, fileHashes, listSourceFiles } from "../acquisition/program.js";
import { listPythonFiles } from "../acquisition/python.js";
import { FindPythonCallersResult, findPythonCallersTask } from "../tasks/find-python-callers.js";

/**
 * Every file this Engine tracks for staleness/revision purposes, across
 * *both* language tracks. `listSourceFiles` alone (TS/JS-only) used to be
 * the sole input to `fileHashes`/`detectRevision`/`KnowledgeStore.staleFiles`
 * everywhere in this file, even though `recordFileHash` is called for `.py`
 * files too (see `acquirePythonFilesAndModules`). That mismatch meant every
 * `.py` file was invisible to "current" and therefore looked *stale* forever
 * — see the constructor's `hydrateFromCache` call and `refresh()` below for
 * where this actually bites: a second `Engine` construction against a
 * cached Python repo would silently invalidate every Python entity while
 * `isAnalysisComplete("ParsePythonSource"/...)` (not file-scoped) kept
 * reporting the analysis as done, so nothing re-ran to repair it.
 */
function listAllTrackedFiles(root: string): string[] {
  return [...listSourceFiles(root), ...listPythonFiles(root)];
}

export interface EngineOptions {
  coveragePath?: string | null;
  tracePath?: string | null;
  lcovPath?: string | null;
  testResultsPath?: string | null;
  stackTracePath?: string | null;
  docsGlobRoot?: string | null;
  allowNetwork?: boolean;
  maxIterations?: number;
  /** planning mode: adaptive (default), exhaustive, or required-only */
  plannerMode?: PlannerMode;
  /** wall-clock budget for optional analyses */
  budgetMs?: number | null;
  /** minimum measured value of information (uncertainty points per second) */
  marginalValueFloor?: number;
  /** shared observation table, so measurements carry across queries. Overrides the auto-persisted per-repo memory below when supplied. */
  plannerMemory?: PlannerOptions["memory"];
  /** task-level computation cache; a repeat query against an unchanged revision is free */
  queryCache?: QueryCache;
  /**
   * Independent verification/challenge layer for FindCallers/FindCallees.
   * `criticality` and `policy` are per-call overrides (see findCallers/
   * findCallees); this only sets the default and whether "recommended"
   * verification actually runs automatically.
   */
  verification?: VerifyOptions;
  /**
   * Persist facts and planner memory to disk between process invocations
   * (SQLite-backed, per repository, content-hash keyed). Default true. A
   * caller that already keeps an Engine warm across many calls (a daemon,
   * the MCP server) can set this false to skip the disk round-trip on every
   * task call and instead call `persist()`/`close()` explicitly.
   */
  cache?: boolean;
  /** Override where the persistent cache lives. Defaults to $SIE_CACHE_DIR or ~/.sie-cache */
  cacheDir?: string | null;
  /**
   * Write to the cache after every mutating call. Default true. A caller
   * that keeps this Engine warm in memory across many calls (the daemon)
   * can set this false and call `persist()`/`close()` on its own schedule,
   * since the in-memory store is already the source of truth between calls.
   */
  autoPersist?: boolean;
}

function repoCacheDir(explicit?: string | null): string {
  return explicit ?? process.env.SIE_CACHE_DIR ?? path.join(os.homedir(), ".sie-cache");
}

function repoKey(root: string): string {
  return createHash("sha1").update(root).digest("hex").slice(0, 16);
}

/**
 * Programmatic API. CLI and MCP both call this class; there is no duplicated
 * intelligence logic anywhere else.
 */
export class Engine {
  readonly root: string;
  readonly store: KnowledgeStore;
  readonly revisionSource: "git" | "content-hash";
  private ctx: AnalysisContext;
  private planner: Planner;
  private readonly cache: FactCache | null;
  private readonly usingExternalMemory: boolean;
  private readonly plannerMemoryFile: string;
  private readonly autoPersist: boolean;
  /** how many files were reused from the persistent cache at construction time */
  readonly restoredFromCache: number;
  readonly queryCache: QueryCache | null;
  private readonly verificationOptions: VerifyOptions;

  constructor(root: string, options: EngineOptions = {}) {
    this.root = path.resolve(root);
    const files = listAllTrackedFiles(this.root);
    const { revision, source } = detectRevision(this.root, files);
    this.revisionSource = source;
    this.store = new KnowledgeStore(this.root, revision);
    this.plannerMemoryFile = path.join(
      repoCacheDir(options.cacheDir),
      `planner-memory-${repoKey(this.root)}.json`,
    );

    const cacheEnabled = options.cache ?? true;
    this.autoPersist = options.autoPersist ?? true;
    this.cache = cacheEnabled ? new FactCache({ cacheDir: options.cacheDir ?? null }) : null;
    this.restoredFromCache = 0;
    if (this.cache) {
      const current = fileHashes(files, this.root);
      const { restoredFiles } = hydrateFromCache(this.store, this.cache, current);
      this.restoredFromCache = restoredFiles;
      // hydrateFromCache restores the cached revision string too; bring it
      // forward to whatever the working tree/git HEAD is right now.
      this.store.revision = revision;
    }

    this.usingExternalMemory = options.plannerMemory !== undefined;
    const memory =
      options.plannerMemory ?? (this.cache ? PlannerMemory.load(this.plannerMemoryFile) : new PlannerMemory());

    this.ctx = createContext(this.root, this.store, {
      coveragePath: options.coveragePath ?? null,
      tracePath: options.tracePath ?? null,
      lcovPath: options.lcovPath ?? null,
      testResultsPath: options.testResultsPath ?? null,
      stackTracePath: options.stackTracePath ?? null,
      allowNetwork: options.allowNetwork ?? false,
    });
    this.queryCache = options.queryCache ?? null;
    this.verificationOptions = options.verification ?? {};
    this.planner = new Planner({
      maxIterations: options.maxIterations ?? 12,
      mode: options.plannerMode ?? "adaptive",
      budgetMs: options.budgetMs ?? null,
      marginalValueFloor: options.marginalValueFloor ?? 0,
      memory,
      queryCache: this.queryCache ?? undefined,
    });
  }

  /** persist() if autoPersist is on; used after every mutating call. */
  private maybePersist(): void {
    if (this.autoPersist) this.persist();
  }

  /**
   * Reuse a previously-computed verification record from the query cache
   * when the primary outcome itself was a cache hit, instead of re-running
   * the independent challenge. Without this, `QueryCache` only saved the
   * planner loop (analysis selection + evidence gathering); the challenge —
   * often the most expensive part of a verified query, since it re-derives
   * the answer via a second, independent mechanism (a fresh
   * `ts.LanguageService`, a fresh AST walk) — reran on *every* call
   * regardless of cache hits, defeating a large part of the cache's point
   * for verified queries.
   *
   * `taskType`/`target` must match what the planner cached the primary
   * outcome under; `computeVerified` is the (possibly expensive) fallback
   * that actually runs the challenge, called only on a genuine miss.
   */
  private withVerificationCache<TResult>(
    taskType: string,
    target: string,
    outcome: PlanOutcome<TResult>,
    computeVerified: () => VerifiedPlanOutcome<TResult>,
  ): VerifiedPlanOutcome<TResult> {
    if (!this.queryCache) return computeVerified();
    const fingerprint = `${ENGINE_FINGERPRINT}:${this.planner.mode}:${this.planner.budgetMs ?? "-"}:${this.planner.marginalValueFloor}`;
    if (outcome.cacheHit) {
      const entry = this.queryCache.peek(taskType, target, this.store.revision, fingerprint);
      if (entry?.verification) {
        const verification = entry.verification as VerificationRecord;
        return { ...outcome, verification, finalStatus: classifyFinalStatus(outcome, verification) };
      }
    }
    const verified = computeVerified();
    this.queryCache.attachVerification(taskType, target, this.store.revision, verified.verification, fingerprint);
    return verified;
  }

  /** Write current facts + planner memory to the persistent cache. Safe to call often; best-effort. */
  persist(): void {
    if (!this.cache) return;
    this.cache.save(this.root, this.store.exportSnapshot());
    if (!this.usingExternalMemory) {
      try {
        fs.mkdirSync(path.dirname(this.plannerMemoryFile), { recursive: true });
        this.planner.memory.save(this.plannerMemoryFile);
      } catch {
        // best-effort: persistence never fails the caller's actual task
      }
    }
  }

  /** Release any open cache handles. Call when done with this Engine in long-lived processes. */
  close(): void {
    this.persist();
    this.cache?.close();
  }

  get plan(): Planner {
    return this.planner;
  }

  get context(): AnalysisContext {
    return this.ctx;
  }

  /** Cheapest crystallization level only: files + modules. */
  async index(): Promise<{ files: number; modules: number; costMs: number }> {
    const { runAnalysis } = await import("../analyses/library.js");
    const outcome = await runAnalysis(analysisByName("ParseSource"), this.ctx);
    const result = {
      files: this.store.entitiesOfKind("File").length,
      modules: this.store.entitiesOfKind("Module").length,
      costMs: outcome.cost.wallClockMs,
    };
    this.maybePersist();
    return result;
  }

  /**
   * Index every .py file under the repository root: files, modules,
   * functions/methods/classes, and name-based CALLS edges (see
   * `src/acquisition/python.ts` for exactly what "name-based" means and
   * doesn't mean). Runs all three Python analyses in dependency order in
   * one call, unlike `index()`'s TS analogue which stops at the cheapest
   * level — there is no separate Python query task yet to gate deeper
   * analysis behind, so there is currently no reason to stop early. A
   * repository with no .py files returns all-zero counts rather than an
   * error: "nothing to index" is a legitimate, non-exceptional outcome.
   */
  async indexPython(): Promise<{
    files: number;
    modules: number;
    functions: number;
    methods: number;
    classes: number;
    callSites: number;
    parseErrors: number;
    costMs: number;
  }> {
    const pyFiles = this.ctx.getPythonHandle().sourceFiles.length;
    if (pyFiles === 0) {
      return { files: 0, modules: 0, functions: 0, methods: 0, classes: 0, callSites: 0, parseErrors: 0, costMs: 0 };
    }
    const { runAnalysis } = await import("../analyses/library.js");
    let costMs = 0;
    for (const name of ["ParsePythonSource", "ResolvePythonSymbols", "ResolvePythonCalls"]) {
      const outcome = await runAnalysis(analysisByName(name), this.ctx);
      costMs += outcome.cost.wallClockMs;
    }
    const isPy = (attrs: Record<string, unknown>) => attrs.language === "python";
    const result = {
      files: this.store.entitiesOfKind("File").filter((e) => isPy(e.attributes)).length,
      modules: this.store.entitiesOfKind("Module").filter((e) => isPy(e.attributes)).length,
      functions: this.store.entitiesOfKind("Function").filter((e) => isPy(e.attributes)).length,
      methods: this.store.entitiesOfKind("Method").filter((e) => isPy(e.attributes)).length,
      classes: this.store.entitiesOfKind("Class").filter((e) => isPy(e.attributes)).length,
      callSites: this.ctx.pythonExtracted?.files.reduce((n, f) => n + f.calls.length, 0) ?? 0,
      parseErrors: this.ctx.pythonExtracted?.errors.length ?? 0,
      costMs,
    };
    this.maybePersist();
    return result;
  }

  /** Incremental invalidation at file granularity (content hash based). */
  refresh(): { stale: string[]; invalidated: number } {
    const files = listAllTrackedFiles(this.root);
    const current = fileHashes(files, this.root);
    const stale = this.store.staleFiles(current);
    for (const file of stale) {
      this.store.invalidateFile(file);
      this.store.addUnknown({
        kind: "stale-index",
        location: { file, line: 1, column: 1 },
        detail: "file content changed since it was analyzed",
      });
    }
    if (stale.length > 0) {
      const priorRevision = this.store.revision;
      const { revision } = detectRevision(this.root, files);
      this.store.revision = revision;
      // Cached task results are addressed by revision; once the revision
      // moves on, entries under the old revision can never be hit again, but
      // dropping them explicitly keeps the cache from growing unboundedly
      // across a long-lived process that repeatedly edits and re-queries.
      if (this.queryCache && revision !== priorRevision) this.queryCache.invalidateRevision(priorRevision);
    }
    const result = { stale, invalidated: stale.length };
    this.maybePersist();
    return result;
  }

  /**
   * `verifyOptions` overrides the engine-level default for this call only
   * (e.g. pass `{ criticality: "high" }` for a security-sensitive query).
   * The independent challenge only runs when the deterministic policy in
   * `verification/policy.ts` decides it should — see docs/verification-layer.md.
   */
  /**
   * FindPythonCallers(symbol): the Python-track analogue of `findCallers`.
   * Deliberately NOT run through `verify*`/`VerifiedPlanOutcome`, for the
   * same reason as `whyDidChange`: there is no second, independently
   * implemented Python call-resolver to challenge the
   * name-based one with (`src/acquisition/python.ts`'s `python3 ast`
   * extractor is the only source), so a "challenge" would just re-ask the
   * same tool the same question. If an independent Python resolver (e.g. a
   * real type checker via pyright/mypy) becomes available, this is the
   * place to wire a verifier in, matching `verifyFindCallers`'s pattern.
   */
  async findPythonCallers(symbol: string): Promise<PlanOutcome<FindPythonCallersResult>> {
    const task = findPythonCallersTask(symbol);
    const outcome = await this.planner.run(task, this.ctx, this.store);
    this.maybePersist();
    return outcome;
  }

  async findCallers(symbol: string, verifyOptions?: VerifyOptions): Promise<VerifiedPlanOutcome<FindCallersResult>> {
    const task = findCallersTask(symbol);
    const outcome = await this.planner.run(task, this.ctx, this.store);
    const verified = this.withVerificationCache(task.type, task.target, outcome, () =>
      verifyFindCallers(outcome, this.store, task, this.root, symbol, { ...this.verificationOptions, ...verifyOptions }),
    );
    this.maybePersist();
    return verified;
  }

  async findCallees(symbol: string, verifyOptions?: VerifyOptions): Promise<VerifiedPlanOutcome<FindCalleesResult>> {
    const task = findCalleesTask(symbol);
    const outcome = await this.planner.run(task, this.ctx, this.store);
    const verified = this.withVerificationCache(task.type, task.target, outcome, () =>
      verifyFindCallees(outcome, this.store, task, this.root, symbol, { ...this.verificationOptions, ...verifyOptions }),
    );
    this.maybePersist();
    return verified;
  }

  async findReferences(symbol: string, verifyOptions?: VerifyOptions): Promise<VerifiedPlanOutcome<FindReferencesResult>> {
    const task = findReferencesTask(symbol);
    const outcome = await this.planner.run(task, this.ctx, this.store);
    const verified = this.withVerificationCache(task.type, task.target, outcome, () =>
      verifyFindReferences(outcome, this.store, task, this.root, symbol, {
        ...this.verificationOptions,
        ...verifyOptions,
      }),
    );
    this.maybePersist();
    return verified;
  }

  async impactOfChange(
    symbol: string,
    maxDepth = 4,
    verifyOptions?: VerifyOptions,
    impactOptions?: { includeReferences?: boolean },
  ): Promise<VerifiedPlanOutcome<ImpactOfChangeResult>> {
    const task = impactOfChangeTask(symbol, maxDepth, impactOptions ?? {});
    const outcome = await this.planner.run(task, this.ctx, this.store);
    const verified = this.withVerificationCache(task.type, task.target, outcome, () =>
      verifyImpactOfChange(outcome, this.store, task, this.root, symbol, {
        ...this.verificationOptions,
        ...verifyOptions,
      }),
    );
    this.maybePersist();
    return verified;
  }

  /**
   * ImportImpact(symbol): dependency-graph impact — which files transitively
   * import the module declaring `symbol`, following re-export/barrel chains
   * (`importImpactTask` / `dependentsOf`). Deliberately a distinct
   * mechanism from `impactOfChange`'s reverse CALLS/REFERENCES traversal
   * (see arm.ts's comment on why the two are scored separately). Not run
   * through `verify*`/`VerifiedPlanOutcome`: there is no second,
   * independently implemented module-resolution pass to
   * challenge the compiler's own `ts.resolveModuleName` result with, the
   * same reasoning already applied to `whyDidChange`/`findPythonCallers`.
   */
  async importImpact(symbol: string, maxDepth = 8): Promise<PlanOutcome<ImportImpactResult>> {
    const task = importImpactTask(symbol, maxDepth);
    const outcome = await this.planner.run(task, this.ctx, this.store);
    this.maybePersist();
    return outcome;
  }

  async whichTestsExercise(
    symbol: string,
    verifyOptions?: VerifyOptions,
  ): Promise<VerifiedPlanOutcome<WhichTestsResult>> {
    const task = whichTestsExerciseTask(symbol);
    const outcome = await this.planner.run(task, this.ctx, this.store);
    const verified = this.withVerificationCache(task.type, task.target, outcome, () =>
      verifyWhichTestsExercise(outcome, this.store, task, this.root, symbol, {
        ...this.verificationOptions,
        ...verifyOptions,
      }),
    );
    this.maybePersist();
    return verified;
  }

  /**
   * WhyDidChange is deliberately NOT run through `verify*`: its evidence is
   * git-history-derived (blame/log, `Soundness: OBSERVATIONAL`), and there
   * is no second, independently-implemented git-history reader in this
   * environment to challenge it with — `git log`/`git blame` themselves are
   * the only source, so a "challenge" would just re-ask the same tool the
   * same question. Per `docs/verification-layer.md`, that is treated as
   * `not-required by policy` rather than an invented, always-agreeing
   * challenge. If an unrelated git-history source becomes available (e.g. a
   * second VCS-log reader), this is the place to wire it in.
   */
  async whyDidChange(symbol: string): Promise<PlanOutcome<WhyChangedResult>> {
    const outcome = await this.planner.run(whyDidChangeTask(symbol), this.ctx, this.store);
    this.maybePersist();
    return outcome;
  }

  async moduleDependents(
    moduleName: string,
    verifyOptions?: VerifyOptions,
  ): Promise<VerifiedPlanOutcome<ModuleDependentsResult>> {
    const task = moduleDependentsTask(moduleName);
    const outcome = await this.planner.run(task, this.ctx, this.store);
    const verified = this.withVerificationCache(task.type, task.target, outcome, () =>
      verifyModuleDependents(outcome, this.store, task, this.root, moduleName, {
        ...this.verificationOptions,
        ...verifyOptions,
      }),
    );
    this.maybePersist();
    return verified;
  }

  /** How deeply the repository is currently understood, derived from completed analyses. */
  crystallization(): CrystallizationReport {
    return crystallizationLevel(this.store.completedAnalyses(), applicableAnalysisNames(this.ctx));
  }

  /**
   * First-contact task: a compressed, evidence-backed structural summary of
   * the repository, trimmed to `tokenBudget`. Unlike every other task on
   * this class, the caller doesn't need to already know a symbol or module
   * name — this is what an agent runs before it can ask a targeted question.
   *
   * Guarantees only crystallization level 1 (ParseSource: files + modules +
   * import edges) has run, the same guarantee `index()` makes, and reuses it
   * if already satisfied instead of re-parsing. It never triggers deeper
   * analysis (symbols, types, calls) on its own — those stay gated behind
   * the planner for whichever targeted task actually needs them; this task
   * just reports whatever level the repo already happens to be at.
   */
  async repoOverview(tokenBudget = 2000): Promise<RepoOverviewResult> {
    // "repository" mirrors the private SCOPE constant in analyses/library.ts;
    // ParseSource always runs at that scope, so this check is safe without
    // importing an internal constant across module boundaries.
    if (!this.store.isAnalysisComplete("ParseSource", "repository")) {
      const { runAnalysis, analysisByName } = await import("../analyses/library.js");
      await runAnalysis(analysisByName("ParseSource"), this.ctx);
    }
    const result = repoOverview(this.store, tokenBudget, applicableAnalysisNames(this.ctx));
    this.maybePersist();
    return result;
  }
}
