/**
 * Progressive crystallization.
 *
 * Analyses are assigned a depth level. The planner never requests a level it
 * does not need for the active task; `requiredLevel` is derived from the task's
 * required analyses, not from a global "index everything" pass.
 */

export type CrystallizationLevel = 0 | 1 | 2 | 3 | 4 | 5;

export const LEVEL_DESCRIPTIONS: Record<CrystallizationLevel, string> = {
  0: "repository metadata (revision, file inventory)",
  1: "files and modules with import/export edges",
  2: "declared symbols and references",
  3: "types, calls and dependency edges",
  4: "runtime, test, coverage and history evidence",
  5: "expensive specialised analysis (external forge data)",
};

export const ANALYSIS_LEVEL: Record<string, CrystallizationLevel> = {
  ParseSource: 1,
  ResolveSymbols: 2,
  BuildReferences: 2,
  ResolveTypes: 3,
  AnalyzeInheritance: 3,
  ResolveCalls: 3,
  AnalyzeGitHistory: 4,
  AnalyzeGitMetrics: 4,
  IngestCoverage: 4,
  IngestLcovCoverage: 4,
  IngestTestResults: 4,
  IngestStackTraces: 4,
  IngestRuntimeTrace: 4,
  AnalyzeDocumentation: 4,
  IngestForgeData: 5,
  // Python acquisition track (src/acquisition/python.ts). Levels mirror the
  // TS analogue each stands in for (files+modules / symbols / calls), but
  // these only ever count toward `current` for a repo where they're
  // *applicable* -- see `applicable` below and applicableAnalysisNames() in
  // analyses/library.ts. Without that filter, any TypeScript-only repo
  // (including every existing fixture) would stall at level 0 forever,
  // since it could never satisfy a Python analysis's precondition.
  ParsePythonSource: 1,
  ResolvePythonSymbols: 2,
  ResolvePythonCalls: 3,
};

export function levelOf(analysis: string): CrystallizationLevel {
  const level = ANALYSIS_LEVEL[analysis];
  if (level === undefined) throw new Error(`no crystallization level declared for analysis ${analysis}`);
  return level;
}

export function requiredLevel(analyses: string[]): CrystallizationLevel {
  return analyses.reduce<CrystallizationLevel>((max, name) => {
    const level = levelOf(name);
    return level > max ? level : max;
  }, 0);
}

export interface CrystallizationReport {
  current: CrystallizationLevel;
  description: string;
  completedAnalyses: string[];
  byLevel: Record<CrystallizationLevel, string[]>;
  missingForNextLevel: string[];
}

/**
 * A level is "reached" only when every analysis at that level and below has
 * completed. A partially completed level is reported as not reached, with the
 * missing analyses named — the engine never claims depth it does not have.
 *
 * `applicableAnalyses`, when provided, restricts which declared analyses are
 * even considered: an analysis outside this set is treated as not existing
 * for this repo, not as "missing". This is what lets a repo-conditional
 * analysis (e.g. the Python acquisition track, applicable only when the
 * repo has .py files) coexist with the rest of ANALYSIS_LEVEL without
 * capping every repo that doesn't apply to it at level 0 forever.
 *
 * Omitting it means every declared analysis in ANALYSIS_LEVEL is
 * considered applicable, including conditional ones — this is NOT the same
 * as "the behavior before conditional analyses existed": a TS-only repo
 * queried this way will now report `ParsePythonSource` (etc.) as
 * permanently missing, capping it below the level it should actually be
 * able to reach. Every call site in this codebase
 * (`Engine.crystallization()`, `Engine.repoOverview()`) passes
 * `applicableAnalysisNames(ctx)` from `analyses/library.ts` for exactly
 * this reason; treat omitting the second argument as a bug unless the
 * caller genuinely has no per-repo applicability to compute (e.g. a
 * generic test of the level-arithmetic itself, unrelated to any real repo).
 */
export function crystallizationLevel(
  completed: string[],
  applicableAnalyses?: string[],
): CrystallizationReport {
  // `completed` comes from KnowledgeStore.completedAnalyses(), which returns
  // "analysisName|scope" keys (see KnowledgeStore.markAnalysisComplete) —
  // not bare analysis names. Strip the scope before matching against
  // ANALYSIS_LEVEL, whose keys are bare names. Without this, every entry
  // fails to match and crystallizationLevel() silently reports level 0
  // forever, no matter how much analysis has actually run — a real,
  // previously-undetected bug, not a hypothetical one: `Engine.crystallization()`
  // has called this with the raw scoped keys since the completion-tracking
  // scope was introduced.
  const done = new Set(completed.map((c) => c.split("|")[0] ?? c));
  const applicableSet = applicableAnalyses ? new Set(applicableAnalyses) : null;
  const entries = Object.entries(ANALYSIS_LEVEL).filter(
    ([name]) => applicableSet === null || applicableSet.has(name),
  );
  const byLevel = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] } as Record<CrystallizationLevel, string[]>;
  for (const [name, level] of entries) {
    if (done.has(name)) byLevel[level].push(name);
  }
  const missingAt = (level: CrystallizationLevel): string[] =>
    entries.filter(([name, l]) => l === level && !done.has(name)).map(([name]) => name);

  let current: CrystallizationLevel = 0;
  for (const level of [1, 2, 3, 4, 5] as CrystallizationLevel[]) {
    if (missingAt(level).length === 0 && byLevel[level].length > 0) current = level;
    else break;
  }
  const next = (current + 1) as CrystallizationLevel;
  return {
    current,
    description: LEVEL_DESCRIPTIONS[current],
    completedAnalyses: [...done].sort(),
    byLevel,
    missingForNextLevel: next <= 5 ? missingAt(next) : [],
  };
}
