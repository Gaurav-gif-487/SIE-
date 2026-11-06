import { KnowledgeStore } from "../knowledge/store.js";
import { crystallizationLevel, CrystallizationReport } from "../crystallization/levels.js";
import { estimateTokens } from "../reasoning/tokens.js";

/**
 * RepoOverview: the repo-scale "give me a map" primitive.
 *
 * Every other task (FindCallers, ImpactOfChange, ModuleDependents, ...)
 * requires the caller to already know which symbol or module to ask about.
 * This is the first-contact task an agent runs before it can ask a targeted
 * question: a compressed, evidence-backed structural summary of whatever the
 * engine currently knows, trimmed to a token budget the same way
 * `reasoning/context.ts` trims a FindCallers context pack.
 *
 * Deliberately NOT a planner TaskDefinition (see tasks/task.ts): it does not
 * choose analyses to run based on evidentiary need for one symbol; it
 * reports what's already crystallized (see crystallization/levels.ts) and
 * is honest when that's shallow. It never triggers analysis beyond the
 * cheapest level (ParseSource) itself — see Engine.repoOverview, which
 * ensures that much has run — because anything deeper is exactly the kind
 * of expensive, targeted work the planner exists to gate.
 */

export interface ModuleSummary {
  module: string;
  /** modules that import this one — counted from IMPORTS relations, not estimated */
  fanIn: number;
  /** modules this one imports */
  fanOut: number;
  /** symbols DECLARES'd by this module; 0 if ResolveSymbols hasn't run yet, not "none exist" */
  declaredSymbols: number;
  exportedSymbols: number;
}

export interface RepoOverviewResult {
  root: string;
  revision: string;
  crystallization: CrystallizationReport;
  totals: {
    files: number;
    modules: number;
    /** DECLARES'd symbol entities; reflects crystallization level, not necessarily the true count */
    symbols: number;
    unresolvedImports: number;
    unknownRegions: number;
    conflicts: number;
  };
  /** highest fan-in modules first — the parts of the repo most depended-upon, by counted import edges */
  coreModules: ModuleSummary[];
  /** modules nothing in the repo imports (entry points, scripts, or genuinely unused) */
  leafModules: ModuleSummary[];
  unknownsByKind: { kind: string; count: number }[];
  tokenBudget: number;
  estimatedTokens: number;
  /** true when more modules exist than the budget could list */
  truncated: boolean;
  /** false only when the engine has not even reached level 1 (no files/modules known at all) */
  sufficient: boolean;
}

/**
 * Build the overview from whatever's currently in `store`. Pure function of
 * store state — no analysis is run here (see Engine.repoOverview for the
 * one cheap ParseSource guarantee).
 */
export function repoOverview(
  store: KnowledgeStore,
  tokenBudget = 2000,
  applicableAnalyses?: string[],
): RepoOverviewResult {
  const crystallization = crystallizationLevel(store.completedAnalyses(), applicableAnalyses);

  const moduleEntities = store.entitiesOfKind("Module");
  const fileEntities = store.entitiesOfKind("File");
  const symbolRelations = store.relationsOfKind("DECLARES").filter((r) => moduleEntities.some((m) => m.id === r.from));
  const importRelations = store.relationsOfKind("IMPORTS");

  const summaries: ModuleSummary[] = moduleEntities.map((m) => {
    const declares = symbolRelations.filter((r) => r.from === m.id);
    const exported = declares.filter((r) => {
      const sym = store.getEntity(r.to ?? "");
      return sym?.attributes.exported === true;
    });
    return {
      module: m.name,
      fanIn: importRelations.filter((r) => r.to === m.id).length,
      fanOut: importRelations.filter((r) => r.from === m.id).length,
      declaredSymbols: declares.length,
      exportedSymbols: exported.length,
    };
  });

  const coreModulesAll = [...summaries].sort((a, b) => b.fanIn - a.fanIn || a.module.localeCompare(b.module));
  const leafModulesAll = summaries
    .filter((s) => s.fanIn === 0)
    .sort((a, b) => b.fanOut - a.fanOut || a.module.localeCompare(b.module));

  const unknownsByKindMap = new Map<string, number>();
  for (const region of store.unknownRegions()) {
    unknownsByKindMap.set(region.kind, (unknownsByKindMap.get(region.kind) ?? 0) + 1);
  }
  const unknownsByKind = [...unknownsByKindMap.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);

  const totals = {
    files: fileEntities.length,
    modules: moduleEntities.length,
    symbols: symbolRelations.length,
    unresolvedImports: store.unresolvedRelations("IMPORTS").length,
    unknownRegions: store.unknownRegions().length,
    conflicts: store.conflicts().length,
  };

  // Budget-aware trimming, same pattern as buildFindCallersContext: fixed
  // overhead first (totals/crystallization/unknowns lines), then greedily
  // add module summary lines in relevance order (core first, then leaves)
  // until the budget is spent.
  const headerLines = [
    `REPO ${store.repositoryRoot} @ ${store.revision}`,
    `crystallization level ${crystallization.current}: ${crystallization.description}`,
    `totals: files=${totals.files} modules=${totals.modules} symbols=${totals.symbols} unresolvedImports=${totals.unresolvedImports} unknownRegions=${totals.unknownRegions} conflicts=${totals.conflicts}`,
    ...unknownsByKind.map((u) => `UNKNOWN ${u.kind} x${u.count}`),
  ];
  let tokens = headerLines.reduce((n, l) => n + estimateTokens(l), 0);

  const coreModules: ModuleSummary[] = [];
  for (const s of coreModulesAll) {
    const line = `CORE ${s.module} fanIn=${s.fanIn} fanOut=${s.fanOut} declares=${s.declaredSymbols} exports=${s.exportedSymbols}`;
    const cost = estimateTokens(line);
    if (tokens + cost > tokenBudget) break;
    tokens += cost;
    coreModules.push(s);
  }

  const leafModules: ModuleSummary[] = [];
  for (const s of leafModulesAll) {
    const line = `LEAF ${s.module} fanOut=${s.fanOut} declares=${s.declaredSymbols} exports=${s.exportedSymbols}`;
    const cost = estimateTokens(line);
    if (tokens + cost > tokenBudget) break;
    tokens += cost;
    leafModules.push(s);
  }

  const truncated = coreModules.length < coreModulesAll.length || leafModules.length < leafModulesAll.length;

  return {
    root: store.repositoryRoot,
    revision: store.revision,
    crystallization,
    totals,
    coreModules,
    leafModules,
    unknownsByKind,
    tokenBudget,
    estimatedTokens: tokens,
    truncated,
    sufficient: crystallization.current >= 1,
  };
}
