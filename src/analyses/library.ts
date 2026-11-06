import { KnowledgeStore } from "../knowledge/store.js";
import { ProgramHandle, createProgram } from "../acquisition/program.js";
import { Counters, CostRecord, measure } from "../cost/measure.js";
import { Soundness } from "../canonical/model.js";
import {
  acquireFilesAndModules,
  acquireInheritance,
  acquireSymbols,
  acquireTypes,
} from "../acquisition/symbols.js";
import { CallSite, acquireCalls, acquireReferences } from "../acquisition/calls.js";
import { acquireCoverage, acquireGitHistory, acquireRuntimeTrace } from "../acquisition/signals.js";
import { acquireLcov, acquireStackTraces, acquireTestResults } from "../acquisition/runtime.js";
import { acquireDocumentation } from "../acquisition/docs.js";
import { acquireGitMetrics } from "../acquisition/git-metrics.js";
import { acquireForgeData } from "../acquisition/forge.js";
import {
  ExtractorOutput,
  PythonProgramHandle,
  acquirePythonCalls,
  acquirePythonFilesAndModules,
  acquirePythonSymbols,
  loadPythonProgram,
} from "../acquisition/python.js";

export interface AnalysisContext {
  root: string;
  store: KnowledgeStore;
  /** lazily created program; created once and reused across analyses */
  getProgram: () => ProgramHandle;
  /** lazily created Python file handle; created once and reused across analyses */
  getPythonHandle: () => PythonProgramHandle;
  /** intermediate output from ParsePythonSource, consumed by ResolvePythonSymbols/Calls */
  pythonExtracted: ExtractorOutput | null;
  /** name -> candidate entity ids, produced by ResolvePythonSymbols, consumed by ResolvePythonCalls */
  pythonCandidates: Map<string, string[]> | null;
  /** optional external inputs; absent inputs are reported as UNKNOWN, never faked */
  coveragePath: string | null;
  tracePath: string | null;
  lcovPath: string | null;
  testResultsPath: string | null;
  stackTracePath: string | null;
  /** external network sources are opt-in; default false keeps analysis local */
  allowNetwork: boolean;
  /** call sites produced by ResolveCalls, if it has run */
  callSites: CallSite[] | null;
}

export interface AnalysisResult {
  name: string;
  cost: CostRecord;
  notes: string[];
  soundness: Soundness;
}

export interface Analysis {
  name: string;
  description: string;
  inputs: string[];
  outputs: string[];
  /** analyses that must have completed first */
  dependencies: string[];
  /**
   * What kind of claim this analysis is entitled to make about the world,
   * independent of how confident any single result looks. See
   * `Soundness` in canonical/model.ts. Declared once per analysis, not
   * invented per result.
   */
  soundness: Soundness;
  /**
   * Whether this analysis is even relevant to this repository, independent
   * of whether it has run yet. Defaults to always-applicable (every
   * TypeScript acquisition analysis) when omitted. An analysis whose
   * `applicable` returns false for a given repo is excluded from that
   * repo's crystallization accounting entirely (see
   * `applicableAnalysisNames` and `crystallization/levels.ts`) rather than
   * counted as perpetually missing.
   */
  applicable?: (ctx: AnalysisContext) => boolean;
  /** true when this analysis can run right now */
  precondition: (ctx: AnalysisContext) => boolean;
  /** true when its output already exists for the current revision */
  satisfied: (ctx: AnalysisContext) => boolean;
  run: (ctx: AnalysisContext, counters: Counters) => string[] | Promise<string[]>;
}

const SCOPE = "repository";

export const ParseSource: Analysis = {
  name: "ParseSource",
  description: "Repository -> files + modules + import/export edges (cheapest crystallization level)",
  inputs: ["filesystem"],
  outputs: ["File", "Module", "IMPORTS", "EXPORTS"],
  dependencies: [],
  soundness: "SOUND_UNDER_ASSUMPTIONS",
  precondition: () => true,
  satisfied: (ctx) => ctx.store.isAnalysisComplete("ParseSource", SCOPE),
  run: (ctx, counters) => {
    acquireFilesAndModules(ctx.getProgram(), ctx.store, counters);
    return [`files=${ctx.store.entitiesOfKind("File").length}`];
  },
};

export const ResolveSymbols: Analysis = {
  name: "ResolveSymbols",
  description: "Module -> declared symbols (functions, methods, classes, interfaces, types)",
  inputs: ["File", "Module"],
  outputs: ["Function", "Method", "Class", "Interface", "Type", "DECLARES"],
  dependencies: ["ParseSource"],
  soundness: "SOUND_UNDER_ASSUMPTIONS",
  precondition: (ctx) => ctx.store.entitiesOfKind("File").length > 0,
  satisfied: (ctx) => ctx.store.isAnalysisComplete("ResolveSymbols", SCOPE),
  run: (ctx, counters) => {
    acquireSymbols(ctx.getProgram(), ctx.store, counters);
    return [`symbols=${counters.symbolsProcessed}`];
  },
};

export const ResolveTypes: Analysis = {
  name: "ResolveTypes",
  description: "Attach type checker types, signatures and return types to declared symbols",
  inputs: ["Symbol declarations"],
  outputs: ["typeText", "returnType", "parameterTypes"],
  dependencies: ["ResolveSymbols"],
  soundness: "SOUND_UNDER_ASSUMPTIONS",
  precondition: (ctx) => ctx.store.isAnalysisComplete("ResolveSymbols", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("ResolveTypes", SCOPE),
  run: (ctx, counters) => {
    acquireTypes(ctx.getProgram(), ctx.store, counters);
    return [`typed=${counters.symbolsProcessed}`];
  },
};

export const AnalyzeInheritance: Analysis = {
  name: "AnalyzeInheritance",
  description: "EXTENDS / IMPLEMENTS edges between classes and interfaces",
  inputs: ["Class", "Interface"],
  outputs: ["EXTENDS", "IMPLEMENTS"],
  dependencies: ["ResolveSymbols"],
  soundness: "SOUND_UNDER_ASSUMPTIONS",
  precondition: (ctx) => ctx.store.isAnalysisComplete("ResolveSymbols", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("AnalyzeInheritance", SCOPE),
  run: (ctx, counters) => {
    acquireInheritance(ctx.getProgram(), ctx.store, counters);
    return [
      `extends=${ctx.store.relationsOfKind("EXTENDS").length}`,
      `implements=${ctx.store.relationsOfKind("IMPLEMENTS").length}`,
    ];
  },
};

export const ResolveCalls: Analysis = {
  name: "ResolveCalls",
  description: "Type-aware call resolution for every call/new expression",
  inputs: ["Symbol declarations", "types"],
  outputs: ["CALLS", "resolution status", "risk factors"],
  dependencies: ["ResolveTypes"],
  soundness: "SOUND_UNDER_ASSUMPTIONS",
  precondition: (ctx) => ctx.store.isAnalysisComplete("ResolveTypes", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("ResolveCalls", SCOPE),
  run: (ctx, counters) => {
    ctx.callSites = acquireCalls(ctx.getProgram(), ctx.store, counters);
    return [`callSites=${ctx.callSites.length}`];
  },
};

export const BuildReferences: Analysis = {
  name: "BuildReferences",
  description: "Non-call identifier references resolved through the checker",
  inputs: ["Symbol declarations"],
  outputs: ["REFERENCES"],
  dependencies: ["ResolveSymbols"],
  soundness: "SOUND_UNDER_ASSUMPTIONS",
  precondition: (ctx) => ctx.store.isAnalysisComplete("ResolveSymbols", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("BuildReferences", SCOPE),
  run: (ctx, counters) => {
    acquireReferences(ctx.getProgram(), ctx.store, counters);
    return [`references=${ctx.store.relationsOfKind("REFERENCES").length}`];
  },
};

export const AnalyzeGitHistory: Analysis = {
  name: "AnalyzeGitHistory",
  description: "Real git log ingestion (CHANGED_BY). Reports no-git-data when unavailable",
  inputs: ["git"],
  outputs: ["Commit", "CHANGED_BY"],
  dependencies: ["ParseSource"],
  soundness: "OBSERVATIONAL",
  precondition: (ctx) => ctx.store.entitiesOfKind("File").length > 0,
  satisfied: (ctx) => ctx.store.isAnalysisComplete("AnalyzeGitHistory", SCOPE),
  run: (ctx, counters) => {
    const res = acquireGitHistory(ctx.root, ctx.store, counters);
    return [`gitAvailable=${res.available}`, `commits=${res.commits}`];
  },
};

export const IngestCoverage: Analysis = {
  name: "IngestCoverage",
  description: "Ingest an istanbul coverage-final.json produced by a real test run",
  inputs: ["coverage file"],
  outputs: ["RuntimeEvent", "EXECUTED_AS"],
  dependencies: ["ParseSource"],
  soundness: "OBSERVATIONAL",
  precondition: (ctx) => ctx.coveragePath !== null,
  satisfied: (ctx) => ctx.store.isAnalysisComplete("IngestCoverage", SCOPE),
  run: (ctx, counters) => {
    const res = acquireCoverage(ctx.coveragePath, ctx.root, ctx.store, counters);
    return [`coverageAvailable=${res.available}`, `executedStatements=${res.executedLines}`];
  },
};

export const IngestRuntimeTrace: Analysis = {
  name: "IngestRuntimeTrace",
  description: "Ingest an observed call trace from an instrumented run",
  inputs: ["trace file"],
  outputs: ["RuntimeEvent", "EXECUTED_AS", "CONFLICTING evidence"],
  dependencies: ["ResolveCalls"],
  soundness: "OBSERVATIONAL",
  precondition: (ctx) => ctx.tracePath !== null && ctx.store.isAnalysisComplete("ResolveCalls", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("IngestRuntimeTrace", SCOPE),
  run: (ctx, counters) => {
    const res = acquireRuntimeTrace(ctx.tracePath, ctx.store, counters);
    return [`traceAvailable=${res.available}`, `events=${res.events}`, `conflicts=${res.conflicts}`];
  },
};


export const AnalyzeGitMetrics: Analysis = {
  name: "AnalyzeGitMetrics",
  description: "Churn, authors, recency, hotspots and change coupling from real git history",
  inputs: ["git", "File"],
  outputs: ["COUPLED_WITH", "commits", "hotspotScore"],
  dependencies: ["AnalyzeGitHistory"],
  soundness: "OBSERVATIONAL",
  precondition: (ctx) => ctx.store.entitiesOfKind("File").length > 0,
  satisfied: (ctx) => ctx.store.isAnalysisComplete("AnalyzeGitMetrics", SCOPE),
  run: (ctx, counters) => {
    const res = acquireGitMetrics(ctx.root, ctx.store, counters);
    return [`gitAvailable=${res.available}`, `files=${res.filesMeasured}`, `couplingPairs=${res.couplingPairs}`];
  },
};

export const IngestLcovCoverage: Analysis = {
  name: "IngestLcovCoverage",
  description: "Ingest an LCOV report from a real test run and attach it to files and symbols",
  inputs: ["lcov file", "Symbol declarations"],
  outputs: ["Coverage", "COVERS"],
  dependencies: ["ResolveSymbols"],
  soundness: "OBSERVATIONAL",
  precondition: (ctx) => ctx.lcovPath !== null && ctx.store.isAnalysisComplete("ResolveSymbols", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("IngestLcovCoverage", SCOPE),
  run: (ctx, counters) => {
    const res = acquireLcov(ctx.lcovPath, ctx.root, ctx.store, counters);
    return [`lcovAvailable=${res.available}`, `coveredLines=${res.coveredLines}`, `coveredSymbols=${res.coveredSymbols}`];
  },
};

export const IngestTestResults: Analysis = {
  name: "IngestTestResults",
  description: "Ingest Vitest/Jest JSON reporter output; map failure stack frames to symbols",
  inputs: ["test results json"],
  outputs: ["Test", "TESTS"],
  dependencies: ["ResolveSymbols"],
  soundness: "OBSERVATIONAL",
  precondition: (ctx) => ctx.testResultsPath !== null && ctx.store.isAnalysisComplete("ResolveSymbols", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("IngestTestResults", SCOPE),
  run: (ctx, counters) => {
    const res = acquireTestResults(ctx.testResultsPath, ctx.root, ctx.store, counters);
    return [`available=${res.available}`, `format=${res.format}`, `tests=${res.tests}`, `failed=${res.failed}`];
  },
};

export const IngestStackTraces: Analysis = {
  name: "IngestStackTraces",
  description: "Ingest a real stack-trace log and map frames to files, lines and symbols",
  inputs: ["stack trace log"],
  outputs: ["RuntimeEvent", "EXECUTED_AS"],
  dependencies: ["ResolveSymbols"],
  soundness: "OBSERVATIONAL",
  precondition: (ctx) => ctx.stackTracePath !== null && ctx.store.isAnalysisComplete("ResolveSymbols", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("IngestStackTraces", SCOPE),
  run: (ctx, counters) => {
    const res = acquireStackTraces(ctx.stackTracePath, ctx.root, ctx.store, counters);
    return [`available=${res.available}`, `frames=${res.frames}`, `mappedSymbols=${res.mappedSymbols}`];
  },
};

export const AnalyzeDocumentation: Analysis = {
  name: "AnalyzeDocumentation",
  description: "Link repository markdown to files and symbols; count measurable documentation drift",
  inputs: ["filesystem markdown", "Symbol declarations"],
  outputs: ["Documentation", "DOCUMENTS", "MENTIONS", "documentation-drift"],
  dependencies: ["ResolveSymbols"],
  soundness: "HEURISTIC",
  precondition: (ctx) => ctx.store.isAnalysisComplete("ResolveSymbols", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("AnalyzeDocumentation", SCOPE),
  run: (ctx, counters) => {
    const res = acquireDocumentation(ctx.root, ctx.store, counters);
    return [
      `documents=${res.documents}`,
      `linked=${res.documentsLinked}`,
      `symbolMentions=${res.symbolMentions}`,
      `drift=${res.driftReferences}`,
    ];
  },
};

export const IngestForgeData: Analysis = {
  name: "IngestForgeData",
  description: "Fetch real GitHub/GitLab PRs and issues; unavailable without a remote and token",
  inputs: ["git remote", "forge token"],
  outputs: ["PullRequest", "Issue"],
  dependencies: ["AnalyzeGitHistory"],
  soundness: "OBSERVATIONAL",
  precondition: (ctx) => ctx.allowNetwork,
  satisfied: (ctx) => ctx.store.isAnalysisComplete("IngestForgeData", SCOPE),
  run: async (ctx, counters) => {
    const res = await acquireForgeData(ctx.root, ctx.store, counters);
    return [`available=${res.available}`, `reason=${res.reason ?? "none"}`, `prs=${res.pullRequests}`, `issues=${res.issues}`];
  },
};

export const ParsePythonSource: Analysis = {
  name: "ParsePythonSource",
  description: "Repository -> .py files + modules, via an independent python3 ast extractor",
  inputs: ["filesystem"],
  outputs: ["File", "Module"],
  dependencies: [],
  soundness: "SOUND_UNDER_ASSUMPTIONS",
  applicable: (ctx) => ctx.getPythonHandle().sourceFiles.length > 0,
  precondition: (ctx) => ctx.getPythonHandle().sourceFiles.length > 0,
  satisfied: (ctx) => ctx.store.isAnalysisComplete("ParsePythonSource", SCOPE),
  run: (ctx, counters) => {
    const extracted = acquirePythonFilesAndModules(ctx.getPythonHandle(), ctx.store, counters);
    ctx.pythonExtracted = extracted;
    return [`pyFiles=${extracted.files.length}`, `parseErrors=${extracted.errors.length}`];
  },
};

export const ResolvePythonSymbols: Analysis = {
  name: "ResolvePythonSymbols",
  description: "Module -> declared Python functions/methods/classes, plus best-effort in-repo import resolution",
  inputs: ["File", "Module"],
  outputs: ["Function", "Method", "Class", "DECLARES", "IMPORTS"],
  dependencies: ["ParsePythonSource"],
  soundness: "HEURISTIC",
  applicable: (ctx) => ctx.getPythonHandle().sourceFiles.length > 0,
  precondition: (ctx) => ctx.store.isAnalysisComplete("ParsePythonSource", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("ResolvePythonSymbols", SCOPE),
  run: (ctx, counters) => {
    if (!ctx.pythonExtracted) {
      throw new Error("ResolvePythonSymbols requires ParsePythonSource to have populated ctx.pythonExtracted");
    }
    ctx.pythonCandidates = acquirePythonSymbols(ctx.pythonExtracted, ctx.store, counters);
    return [`pySymbols=${counters.symbolsProcessed}`];
  },
};

export const ResolvePythonCalls: Analysis = {
  name: "ResolvePythonCalls",
  description: "Name-based CALLS edges for Python call sites (no type checker; PARTIAL/AMBIGUOUS, never EXACT)",
  inputs: ["Symbol declarations"],
  outputs: ["CALLS"],
  dependencies: ["ResolvePythonSymbols"],
  soundness: "HEURISTIC",
  applicable: (ctx) => ctx.getPythonHandle().sourceFiles.length > 0,
  precondition: (ctx) => ctx.store.isAnalysisComplete("ResolvePythonSymbols", SCOPE),
  satisfied: (ctx) => ctx.store.isAnalysisComplete("ResolvePythonCalls", SCOPE),
  run: (ctx, counters) => {
    if (!ctx.pythonExtracted || !ctx.pythonCandidates) {
      throw new Error("ResolvePythonCalls requires ParsePythonSource and ResolvePythonSymbols to have run first");
    }
    acquirePythonCalls(ctx.pythonExtracted, ctx.store, counters, ctx.pythonCandidates);
    return [`pyCallSites=${counters.symbolsProcessed}`];
  },
};

export const ANALYSES: Analysis[] = [
  ParseSource,
  ResolveSymbols,
  ResolveTypes,
  AnalyzeInheritance,
  ResolveCalls,
  BuildReferences,
  AnalyzeGitHistory,
  IngestCoverage,
  IngestRuntimeTrace,
  AnalyzeGitMetrics,
  IngestLcovCoverage,
  IngestTestResults,
  IngestStackTraces,
  AnalyzeDocumentation,
  IngestForgeData,
  ParsePythonSource,
  ResolvePythonSymbols,
  ResolvePythonCalls,
];

export function analysisByName(name: string): Analysis {
  const found = ANALYSES.find((a) => a.name === name);
  if (!found) throw new Error(`unknown analysis: ${name}`);
  return found;
}

/**
 * Names of every declared analysis that is actually relevant to this
 * repository right now (independent of whether it has run yet). Feed this
 * to `crystallizationLevel()` so a repo-conditional analysis (e.g. Python
 * acquisition on a repo with no .py files) is excluded from that repo's
 * level accounting instead of counted as perpetually missing.
 */
export function applicableAnalysisNames(ctx: AnalysisContext): string[] {
  return ANALYSES.filter((a) => (a.applicable ? a.applicable(ctx) : true)).map((a) => a.name);
}

export async function runAnalysis(analysis: Analysis, ctx: AnalysisContext): Promise<AnalysisResult> {
  const { value: notes, cost } = await measure(analysis.name, async (counters) => analysis.run(ctx, counters));
  ctx.store.markAnalysisComplete(analysis.name, SCOPE);
  return { name: analysis.name, cost, notes, soundness: analysis.soundness };
}

export function createContext(
  root: string,
  store: KnowledgeStore,
  options: {
    coveragePath?: string | null;
    tracePath?: string | null;
    lcovPath?: string | null;
    testResultsPath?: string | null;
    stackTracePath?: string | null;
    allowNetwork?: boolean;
    files?: string[];
    pythonFiles?: string[];
  } = {},
): AnalysisContext {
  let handle: ProgramHandle | null = null;
  let pythonHandle: PythonProgramHandle | null = null;
  return {
    root,
    store,
    getProgram: () => {
      if (!handle) handle = createProgram(root, options.files);
      return handle;
    },
    getPythonHandle: () => {
      if (!pythonHandle) pythonHandle = loadPythonProgram(root, options.pythonFiles);
      return pythonHandle;
    },
    pythonExtracted: null,
    pythonCandidates: null,
    coveragePath: options.coveragePath ?? null,
    tracePath: options.tracePath ?? null,
    lcovPath: options.lcovPath ?? null,
    testResultsPath: options.testResultsPath ?? null,
    stackTracePath: options.stackTracePath ?? null,
    allowNetwork: options.allowNetwork ?? false,
    callSites: null,
  };
}

export const ANALYSIS_SCOPE = SCOPE;
