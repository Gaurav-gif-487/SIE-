import { execFileSync } from "node:child_process";
import { Entity, Resolution, SourceLocation, UnknownRegion, entityId, formatLocation } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { ResidualRisk, RiskFactor, TaskDefinition, Uncertainty, ratio, riskFromUnknowns } from "./task.js";
import { blameRange } from "../acquisition/git-metrics.js";
import { moduleIdFor } from "../acquisition/ast-utils.js";

/**
 * Task library beyond FindCallers.
 *
 * Each task declares the analyses it needs, computes its own uncertainty from
 * counted evidence and its own residual risk from recorded unknown regions. A
 * task that cannot establish its denominator returns `value: null` (UNKNOWN).
 */

const STATIC_RISK_KINDS = [
  "dynamic-dispatch",
  "reflection",
  "generated-code",
  "unsupported-syntax",
  "unparsed-file",
  "missing-file",
  "stale-index",
] as const;

export interface TargetRef {
  id: string;
  name: string;
  container: string | null;
  location: SourceLocation;
  kind: string;
}

export function resolveTargets(store: KnowledgeStore, query: string): TargetRef[] {
  const idx = query.lastIndexOf(".");
  const container = idx > 0 ? query.slice(0, idx) : null;
  const name = idx > 0 ? query.slice(idx + 1) : query;
  return store
    .allEntities()
    .filter(
      (e) =>
        e.name === name &&
        ["Function", "Method", "Class", "Interface", "Type", "Symbol"].includes(e.kind) &&
        (container === null || String(e.attributes.container ?? "") === container) &&
        Boolean(e.location),
    )
    .map((e) => ({
      id: e.id,
      name: e.name,
      container: (e.attributes.container as string | null) ?? null,
      location: e.location!,
      kind: e.kind,
    }));
}

function isTestFile(file: string): boolean {
  return /(^|\/)tests?\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}
export { isTestFile };

// ------------------------------------------------------------ FindReferences

export interface ReferenceFinding {
  kind: "CALLS" | "REFERENCES";
  fromName: string;
  location: SourceLocation;
  resolution: Resolution;
  text: string;
  evidenceIds: string[];
}

export interface FindReferencesResult {
  symbol: string;
  targets: TargetRef[];
  targetSelectionStatus: "RESOLVED" | "AMBIGUOUS" | "UNKNOWN";
  references: ReferenceFinding[];
  ambiguous: ReferenceFinding[];
  unresolvedNameMatches: number;
}

export function findReferencesTask(symbolQuery: string): TaskDefinition<FindReferencesResult> {
  return {
    type: "FindReferences",
    target: symbolQuery,
    requiredEvidence: ["reference site", "target symbol", "resolution status", "provenance"],
    optionalEvidence: ["documentation mentions", "git history"],
    requiredAnalyses: ["ParseSource", "ResolveSymbols", "ResolveTypes", "ResolveCalls", "BuildReferences"],
    optionalAnalyses: ["AnalyzeInheritance", "AnalyzeDocumentation"],
    threshold: 0.05,
    riskThreshold: 0,

    evaluate: (store) => {
      const targets = resolveTargets(store, symbolQuery);
      const targetIds = new Set(targets.map((t) => t.id));
      const references: ReferenceFinding[] = [];
      const ambiguous: ReferenceFinding[] = [];
      let unresolvedNameMatches = 0;
      const shortName = symbolQuery.split(".").pop()!;

      for (const rel of store.allRelations()) {
        if (rel.kind !== "CALLS" && rel.kind !== "REFERENCES") continue;
        if (!rel.location) continue;
        const candidates = String(rel.attributes.candidates ?? "").split(",").filter(Boolean);
        const hits = (rel.to !== null && targetIds.has(rel.to)) || candidates.some((c) => targetIds.has(c));
        const fromEntity = store.getEntity(rel.from);
        const text = String(rel.attributes.calleeText ?? rel.attributes.text ?? "");
        const finding: ReferenceFinding = {
          kind: rel.kind,
          fromName: fromEntity?.name ?? rel.from,
          location: rel.location,
          resolution: rel.resolution,
          text,
          evidenceIds: store.evidenceFor(rel.id).map((e) => e.id),
        };
        if (hits && rel.resolution === Resolution.EXACT) references.push(finding);
        else if (hits) ambiguous.push(finding);
        else if (
          rel.resolution === Resolution.UNRESOLVED &&
          (text === shortName || text.endsWith(`.${shortName}`))
        ) {
          unresolvedNameMatches += 1;
        }
      }

      return {
        symbol: symbolQuery,
        targets,
        targetSelectionStatus: targets.length === 1 ? "RESOLVED" : targets.length > 1 ? "AMBIGUOUS" : "UNKNOWN",
        references,
        ambiguous,
        unresolvedNameMatches,
      };
    },

    uncertainty: (store, result) => {
      const stale = store.unknownRegions("stale-index").length + store.unknownRegions("unparsed-file").length;
      const denominatorKnown = stale === 0 && result.targets.length > 0;
      const open = result.ambiguous.length + result.unresolvedNameMatches;
      const total = result.references.length + open;
      const value = ratio(open, total, denominatorKnown && total > 0);
      return {
        components: {
          resolvedReferences: result.references.length,
          ambiguousReferences: result.ambiguous.length,
          unresolvedNameMatches: result.unresolvedNameMatches,
          staleFiles: stale,
          denominatorKnown,
        },
        value,
        explanation:
          value === null
            ? denominatorKnown
              ? "no candidate reference site exists; a ratio is undefined"
              : `denominator unknown (${stale} stale/unparsed file(s), ${result.targets.length} target(s))`
            : `${open} of ${total} candidate reference sites are not fully established`,
      };
    },

    risk: (store) => riskFromUnknowns(store, [...STATIC_RISK_KINDS]),
  };
}

// ----------------------------------------------------------- ImpactOfChange

export interface ImpactEdge {
  fromId: string;
  fromName: string;
  toId: string;
  kind: "CALLS" | "REFERENCES";
  depth: number;
  location: SourceLocation;
  resolution: Resolution;
}

export interface ImpactOfChangeResult {
  symbol: string;
  targets: TargetRef[];
  directDependents: { id: string; name: string; file: string }[];
  transitiveDependents: { id: string; name: string; file: string; depth: number }[];
  affectedFiles: string[];
  affectedTests: string[];
  historicalCoChange: { file: string; coChanges: number }[];
  edges: ImpactEdge[];
  openEdges: number;
  maxDepthReached: number;
}

/**
 * ENGINE CHANGE (Phase 1, final validation): `includeReferences` turns the
 * traversal-kind set into an explicit, measurable variable instead of a
 * hardcoded CALLS|REFERENCES union. Default stays true so every previously
 * recorded result reproduces exactly; the Phase-1 benchmark sets it false to
 * measure call-only semantics. Same analyses, same depth bound, same scoring:
 * the two arms differ in exactly one variable.
 */
export function impactOfChangeTask(
  symbolQuery: string,
  maxDepth = 4,
  opts: { includeReferences?: boolean } = {},
): TaskDefinition<ImpactOfChangeResult> {
  const includeReferences = opts.includeReferences !== false;
  return {
    type: "ImpactOfChange",
    target: symbolQuery,
    requiredEvidence: ["reverse call graph", "reverse reference graph", "resolution status"],
    optionalEvidence: ["git co-change history", "test results", "coverage"],
    requiredAnalyses: ["ParseSource", "ResolveSymbols", "ResolveTypes", "ResolveCalls", "BuildReferences"],
    optionalAnalyses: ["AnalyzeInheritance", "AnalyzeGitMetrics", "IngestTestResults", "IngestLcovCoverage"],
    threshold: 0.05,
    riskThreshold: 0,

    evaluate: (store) => {
      const targets = resolveTargets(store, symbolQuery);
      const frontier = new Set(targets.map((t) => t.id));
      const seen = new Set(frontier);
      const edges: ImpactEdge[] = [];
      const dependents = new Map<string, { entity: Entity; depth: number }>();
      let openEdges = 0;
      let depthReached = 0;

      let current = [...frontier];
      for (let depth = 1; depth <= maxDepth && current.length > 0; depth += 1) {
        const next: string[] = [];
        for (const id of current) {
          for (const rel of store.allRelations()) {
            if (rel.kind !== "CALLS" && !(includeReferences && rel.kind === "REFERENCES")) continue;
            if (!rel.location) continue;
            const candidates = String(rel.attributes.candidates ?? "").split(",").filter(Boolean);
            const hits = rel.to === id || candidates.includes(id);
            if (!hits) continue;
            if (rel.resolution !== Resolution.EXACT) openEdges += 1;
            const from = store.getEntity(rel.from);
            edges.push({
              fromId: rel.from,
              fromName: from?.name ?? rel.from,
              toId: id,
              kind: rel.kind,
              depth,
              location: rel.location,
              resolution: rel.resolution,
            });
            if (!from || seen.has(from.id)) continue;
            seen.add(from.id);
            dependents.set(from.id, { entity: from, depth });
            next.push(from.id);
          }
        }
        if (next.length > 0) depthReached = depth;
        current = next;
      }

      const fileOf = (e: Entity): string => String(e.attributes.file ?? e.location?.file ?? "");
      const direct = [...dependents.values()]
        .filter((d) => d.depth === 1)
        .map((d) => ({ id: d.entity.id, name: d.entity.name, file: fileOf(d.entity) }));
      const transitive = [...dependents.values()]
        .filter((d) => d.depth > 1)
        .map((d) => ({ id: d.entity.id, name: d.entity.name, file: fileOf(d.entity), depth: d.depth }));

      const affectedFiles = [
        ...new Set(
          [...targets.map((t) => t.location.file), ...direct.map((d) => d.file), ...transitive.map((d) => d.file)].filter(
            Boolean,
          ),
        ),
      ].sort();

      const affectedTests = affectedFiles.filter(isTestFile);

      const historicalCoChange: { file: string; coChanges: number }[] = [];
      for (const file of targets.map((t) => t.location.file)) {
        const fileId = entityId("File", file);
        for (const rel of store.relationsFrom(fileId, "COUPLED_WITH").concat(store.relationsTo(fileId, "COUPLED_WITH"))) {
          const otherId = rel.from === fileId ? rel.to : rel.from;
          const other = otherId ? store.getEntity(otherId) : null;
          if (!other) continue;
          historicalCoChange.push({ file: other.name, coChanges: Number(rel.attributes.coChanges ?? 0) });
        }
      }
      historicalCoChange.sort((a, b) => b.coChanges - a.coChanges);

      return {
        symbol: symbolQuery,
        targets,
        directDependents: direct,
        transitiveDependents: transitive,
        affectedFiles,
        affectedTests,
        historicalCoChange,
        edges,
        openEdges,
        maxDepthReached: depthReached,
      };
    },

    uncertainty: (store, result) => {
      const stale = store.unknownRegions("stale-index").length + store.unknownRegions("unparsed-file").length;
      const denominatorKnown = stale === 0 && result.targets.length > 0;
      const total = result.edges.length;
      const value = ratio(result.openEdges, total, denominatorKnown && total > 0);
      return {
        components: {
          edges: total,
          openEdges: result.openEdges,
          truncatedAtMaxDepth: result.maxDepthReached >= maxDepth,
          staleFiles: stale,
          denominatorKnown,
        },
        value,
        explanation:
          value === null
            ? denominatorKnown
              ? "nothing depends on the target in the analyzed scope; a ratio is undefined"
              : `denominator unknown (${stale} stale/unparsed file(s), ${result.targets.length} target(s))`
            : `${result.openEdges} of ${total} impact edges are not EXACT` +
              (result.maxDepthReached >= maxDepth ? `; traversal truncated at depth ${maxDepth}` : ""),
      };
    },

    risk: (store, result) => {
      // Same fix as FindCallers/FindCallees (see docs/verification-layer.md,
      // §10.1): a repo-wide `riskFromUnknowns` scan made every ImpactOfChange
      // query trigger on unproven regions the traversal never actually
      // touched. Scope to the files this specific traversal reached
      // (`result.affectedFiles`, which already includes the target's own
      // file) plus store-wide conflicts, which — same as FindCallers — are
      // kept unscoped because a conflict on any subject the traversal
      // observed evidence from is directly relevant regardless of file.
      const touchedFiles = new Set(result.affectedFiles);
      const factors: RiskFactor[] = [];
      let criticalSites = 0;
      for (const kind of STATIC_RISK_KINDS) {
        const regions = store.unknownRegions(kind as UnknownRegion["kind"]);
        const scoped = regions.filter((r) => r.location && touchedFiles.has(r.location.file));
        if (scoped.length === 0) continue;
        factors.push({
          kind: kind as UnknownRegion["kind"],
          count: scoped.length,
          locations: scoped.slice(0, 10).map((r) => formatLocation(r.location!)),
          detail: scoped[0]!.detail,
        });
        criticalSites += scoped.length;
      }
      const conflicts = store.conflicts();
      if (conflicts.length > 0) {
        factors.push({
          kind: "runtime-static-disagreement",
          count: conflicts.length,
          locations: conflicts.slice(0, 10).map((c) => c.subject),
          detail: "evidence sources disagree; both records retained as CONFLICTING",
        });
        criticalSites += conflicts.length;
      }
      const base: ResidualRisk = {
        factors,
        criticalSites,
        acceptable: criticalSites === 0,
        explanation:
          criticalSites === 0
            ? "no unproven region within the traversed files affects this answer"
            : `${criticalSites} unproven site(s) within the traversed files: ${factors.map((f) => `${f.kind}=${f.count}`).join(", ")}`,
      };
      if (result.maxDepthReached >= maxDepth) {
        base.factors.push({
          kind: "unsupported-syntax",
          count: 1,
          locations: [],
          detail: `impact traversal hit the depth limit (${maxDepth}); deeper dependents were not enumerated`,
        });
        base.criticalSites += 1;
        base.acceptable = false;
        base.explanation += `; traversal truncated at depth ${maxDepth}`;
      }
      return base;
    },
  };
}

// ------------------------------------------------------- WhichTestsExercise

export interface TestFinding {
  test: string;
  file: string;
  evidence: "static-call-path" | "import-reachable" | "coverage" | "stack-trace" | "test-runner-mapping";
  detail: string;
}

export interface WhichTestsResult {
  symbol: string;
  targets: TargetRef[];
  statically: TestFinding[];
  runtimeConfirmed: TestFinding[];
  runtimeEvidence: "AVAILABLE" | "UNKNOWN";
  coverageHits: number | null;
}

export function whichTestsExerciseTask(symbolQuery: string, maxDepth = 6): TaskDefinition<WhichTestsResult> {
  return {
    type: "WhichTestsExercise",
    target: symbolQuery,
    requiredEvidence: ["static call path from a test file", "target symbol"],
    optionalEvidence: ["coverage", "test results", "stack traces"],
    requiredAnalyses: ["ParseSource", "ResolveSymbols", "ResolveTypes", "ResolveCalls"],
    optionalAnalyses: ["IngestLcovCoverage", "IngestTestResults", "IngestStackTraces", "IngestCoverage"],
    threshold: 0.05,
    riskThreshold: 0,

    evaluate: (store) => {
      const targets = resolveTargets(store, symbolQuery);
      const targetIds = new Set(targets.map((t) => t.id));

      // Reverse reachability over CALLS only: which declarations can reach the
      // target, and which of those live in a test file.
      const reached = new Set(targetIds);
      let frontier = [...targetIds];
      for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
        const next: string[] = [];
        for (const rel of store.relationsOfKind("CALLS")) {
          const candidates = String(rel.attributes.candidates ?? "").split(",").filter(Boolean);
          const hits = (rel.to !== null && frontier.includes(rel.to)) || candidates.some((c) => frontier.includes(c));
          if (!hits) continue;
          if (reached.has(rel.from)) continue;
          reached.add(rel.from);
          next.push(rel.from);
        }
        frontier = next;
      }

      const statically: TestFinding[] = [];
      for (const id of reached) {
        if (targetIds.has(id)) continue;
        const entity = store.getEntity(id);
        const file = entity ? String(entity.attributes.file ?? entity.location?.file ?? "") : id.replace(/^File:/, "");
        if (!file || !isTestFile(file)) continue;
        statically.push({
          test: entity?.name ?? file,
          file,
          evidence: "static-call-path",
          detail: `a resolved call path exists from ${entity?.name ?? file} to ${symbolQuery}`,
        });
      }

      // Import reachability: a test can exercise a symbol it never
      // lexically calls (re-exported default, a factory that constructs
      // it, a barrel import) as easily as one it calls directly — the
      // independent oracle's definition is a *union* of call-reachable and
      // import-reachable tests, not call-reachable alone. Walk the same
      // barrel-aware `dependentsOf` traversal used by ImportImpact from
      // each target's declaring module, and flag any test file it reaches
      // that the CALLS walk above didn't already find.
      const staticallyFiles = new Set(statically.map((f) => f.file));
      const importReachedFiles = new Set<string>();
      for (const target of targets) {
        const { files } = dependentsOf(store, moduleIdFor(target.location.file), maxDepth);
        for (const f of files) importReachedFiles.add(f);
      }
      for (const file of importReachedFiles) {
        if (!isTestFile(file) || staticallyFiles.has(file)) continue;
        staticallyFiles.add(file);
        statically.push({
          test: file,
          file,
          evidence: "import-reachable",
          detail: `${file} transitively imports the module declaring ${symbolQuery} (no call-graph edge required)`,
        });
      }

      // Runtime confirmation: coverage on the target's own lines, mapped stack
      // frames, or a test-runner mapping produced from a real failure.
      const runtimeConfirmed: TestFinding[] = [];
      let coverageHits: number | null = null;
      const coverageAvailable = store.entitiesOfKind("Coverage").length > 0;
      if (coverageAvailable) coverageHits = 0;
      for (const target of targets) {
        const start = target.location.line;
        const end = target.location.endLine ?? target.location.line;
        for (const cov of store.entitiesOfKind("Coverage")) {
          const loc = cov.location;
          if (!loc || loc.file !== target.location.file) continue;
          if (loc.line < start || loc.line > end) continue;
          coverageHits = (coverageHits ?? 0) + Number(cov.attributes.hits ?? 0);
        }
        for (const rel of store.relationsTo(target.id, "TESTS")) {
          const test = store.getEntity(rel.from);
          if (!test) continue;
          runtimeConfirmed.push({
            test: test.name,
            file: String(test.attributes.file ?? ""),
            evidence: "test-runner-mapping",
            detail: `test-runner output mapped a stack frame in ${symbolQuery} to this test`,
          });
        }
        for (const rel of store.relationsFrom(target.id, "EXECUTED_AS")) {
          const event = rel.to ? store.getEntity(rel.to) : null;
          if (!event) continue;
          runtimeConfirmed.push({
            test: event.name,
            file: event.location?.file ?? "",
            evidence: "stack-trace",
            detail: `an observed stack frame executed ${symbolQuery}`,
          });
        }
      }

      const runtimeEvidence: "AVAILABLE" | "UNKNOWN" =
        coverageAvailable || runtimeConfirmed.length > 0 || store.entitiesOfKind("Test").length > 0
          ? "AVAILABLE"
          : "UNKNOWN";

      return { symbol: symbolQuery, targets, statically, runtimeConfirmed, runtimeEvidence, coverageHits };
    },

    uncertainty: (store, result) => {
      const stale = store.unknownRegions("stale-index").length + store.unknownRegions("unparsed-file").length;
      const dynamic = store.unknownRegions("dynamic-dispatch").length;
      const denominatorKnown = stale === 0 && result.targets.length > 0;
      const staticCount = result.statically.length;
      const total = staticCount + dynamic;
      const value = ratio(dynamic, total, denominatorKnown && total > 0);
      return {
        components: {
          staticallyReachingTests: staticCount,
          runtimeConfirmed: result.runtimeConfirmed.length,
          dynamicDispatchSites: dynamic,
          runtimeEvidenceAvailable: result.runtimeEvidence === "AVAILABLE",
          staleFiles: stale,
          denominatorKnown,
        },
        value,
        explanation:
          value === null
            ? denominatorKnown
              ? "no test statically reaches the target and no dynamic site could hide one"
              : `denominator unknown (${stale} stale/unparsed file(s), ${result.targets.length} target(s))`
            : `${dynamic} dynamic-dispatch site(s) could hide additional test paths beyond the ${staticCount} statically established`,
      };
    },

    risk: (store, result) => {
      const base = riskFromUnknowns(store, [...STATIC_RISK_KINDS]);
      if (result.runtimeEvidence === "UNKNOWN") {
        base.factors.push({
          kind: "no-runtime-data",
          count: 1,
          locations: [],
          detail: "no coverage, test-result or stack-trace artifact was supplied; execution is unconfirmed",
        });
        base.criticalSites += 1;
        base.acceptable = false;
        base.explanation += "; runtime evidence UNKNOWN";
      }
      return base;
    },
  };
}

// ----------------------------------------------------------- WhyDidXChange

export interface ChangeRecord {
  sha: string;
  author: string;
  dateISO: string;
  summary: string;
  linesTouched: number;
}

export interface WhyChangedResult {
  symbol: string;
  targets: TargetRef[];
  gitAvailable: boolean;
  changes: ChangeRecord[];
  fileCommits: { sha: string; subject: string; date: string; author: string }[];
  documentationMentions: { document: string; line: number }[];
}

export function whyDidChangeTask(symbolQuery: string): TaskDefinition<WhyChangedResult> {
  return {
    type: "WhyDidXChange",
    target: symbolQuery,
    requiredEvidence: ["commit sha", "blame lines", "symbol location"],
    optionalEvidence: ["pull requests", "issues", "documentation"],
    requiredAnalyses: ["ParseSource", "ResolveSymbols", "AnalyzeGitHistory"],
    optionalAnalyses: ["AnalyzeGitMetrics", "AnalyzeDocumentation", "IngestForgeData"],
    threshold: 0.05,
    riskThreshold: 0,

    evaluate: (store) => {
      const targets = resolveTargets(store, symbolQuery);
      const changes = new Map<string, ChangeRecord>();
      let gitAvailable = store.unknownRegions("no-git-data").length === 0;

      for (const target of targets) {
        const start = target.location.line;
        const end = target.location.endLine ?? target.location.line;
        const blame = blameRange(store.repositoryRoot, target.location.file, start, end);
        if (blame === null) {
          gitAvailable = false;
          continue;
        }
        for (const line of blame) {
          const existing = changes.get(line.sha);
          if (existing) existing.linesTouched += 1;
          else
            changes.set(line.sha, {
              sha: line.sha,
              author: line.author,
              dateISO: line.dateISO,
              summary: line.summary,
              linesTouched: 1,
            });
        }
      }

      const fileCommits: WhyChangedResult["fileCommits"] = [];
      for (const target of targets) {
        const fileId = entityId("File", target.location.file);
        for (const rel of store.relationsFrom(fileId, "CHANGED_BY")) {
          const commit = rel.to ? store.getEntity(rel.to) : null;
          if (!commit) continue;
          fileCommits.push({
            sha: commit.name,
            subject: String(commit.attributes.subject ?? ""),
            date: String(commit.attributes.date ?? ""),
            author: String(commit.attributes.author ?? ""),
          });
        }
      }

      const documentationMentions: WhyChangedResult["documentationMentions"] = [];
      for (const target of targets) {
        for (const rel of store.relationsTo(target.id, "MENTIONS")) {
          const doc = store.getEntity(rel.from);
          if (!doc || !rel.location) continue;
          documentationMentions.push({ document: doc.name, line: rel.location.line });
        }
      }

      return {
        symbol: symbolQuery,
        targets,
        gitAvailable,
        changes: [...changes.values()].sort((a, b) => b.dateISO.localeCompare(a.dateISO)),
        fileCommits,
        documentationMentions,
      };
    },

    uncertainty: (_store, result) => {
      const denominatorKnown = result.gitAvailable && result.targets.length > 0;
      const total = result.changes.reduce((n, c) => n + c.linesTouched, 0);
      const withSummary = result.changes
        .filter((c) => c.summary.trim().length > 0)
        .reduce((n, c) => n + c.linesTouched, 0);
      const value = ratio(total - withSummary, total, denominatorKnown && total > 0);
      return {
        components: {
          commits: result.changes.length,
          blamedLines: total,
          linesWithCommitSubject: withSummary,
          gitAvailable: result.gitAvailable,
          denominatorKnown,
        },
        value,
        explanation: denominatorKnown
          ? total === 0
            ? "the symbol's lines produced no blame output; nothing can be attributed"
            : `${total - withSummary} of ${total} blamed lines have no commit subject to explain the change`
          : "git history is unavailable; change attribution is UNKNOWN",
      };
    },

    risk: (store, result) => {
      const base = riskFromUnknowns(store, ["stale-index", "missing-file"]);
      if (!result.gitAvailable) {
        base.factors.push({
          kind: "no-git-data",
          count: 1,
          locations: [],
          detail: "git blame is unavailable for this repository",
        });
        base.criticalSites += 1;
        base.acceptable = false;
      }
      if (store.unknownRegions("no-forge-data").length > 0) {
        base.factors.push({
          kind: "no-forge-data",
          count: 1,
          locations: [],
          detail: "PR/issue rationale is unavailable (source unavailable, not empty)",
        });
        base.criticalSites += 1;
        base.acceptable = false;
      }
      base.explanation =
        base.criticalSites === 0 ? "commit attribution is complete" : `${base.criticalSites} unavailable rationale source(s)`;
      return base;
    },
  };
}

// -------------------------------------------------------- ModuleDependents

/**
 * Reverse dependency BFS from a module id, combining `IMPORTS` and
 * `EXPORTS` edges so re-export/barrel chains propagate reachability: a
 * module that only re-exports the target (`export ... from "./target"`,
 * i.e. `EXPORTS: from=barrel, to=target`) is itself a dependent, and
 * anything that imports *that* barrel is a transitive dependent even
 * though it never imports the target module directly. Without folding in
 * `EXPORTS`, any consumer that goes through a barrel is invisible to this
 * traversal — the single most common way real repositories structure
 * their public API surface.
 *
 * The origin module is included in the returned file set, matching the
 * independent oracle's convention (`bfsReachable` in oracles-ext.ts seeds
 * `seen` with the origin itself) — a file trivially "depends on" itself
 * for impact-analysis purposes.
 */
export function dependentsOf(
  store: KnowledgeStore,
  originModuleId: string,
  maxDepth: number,
): { moduleIds: Set<string>; files: string[]; maxDepthReached: number } {
  const seen = new Set<string>([originModuleId]);
  let frontier = [originModuleId];
  let maxDepthReached = 0;
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const rel of [...store.relationsTo(id, "IMPORTS"), ...store.relationsTo(id, "EXPORTS")]) {
        if (seen.has(rel.from)) continue;
        seen.add(rel.from);
        next.push(rel.from);
      }
    }
    if (next.length > 0) maxDepthReached = depth;
    frontier = next;
  }
  const files = [...seen].map((id) => store.getEntity(id)?.name).filter((f): f is string => Boolean(f)).sort();
  return { moduleIds: seen, files, maxDepthReached };
}

export interface ModuleDependentsResult {
  module: string;
  exists: boolean;
  directDependents: { module: string; specifier: string; location: SourceLocation }[];
  transitiveDependents: { module: string; depth: number }[];
  unresolvedImports: number;
}

export function moduleDependentsTask(moduleQuery: string, maxDepth = 8): TaskDefinition<ModuleDependentsResult> {
  return {
    type: "ModuleDependents",
    target: moduleQuery,
    requiredEvidence: ["import edge", "resolved module target"],
    optionalEvidence: ["git co-change"],
    requiredAnalyses: ["ParseSource"],
    optionalAnalyses: ["AnalyzeGitMetrics"],
    threshold: 0.05,
    riskThreshold: 0,

    evaluate: (store) => {
      const normalized = moduleQuery.replace(/^\.\//, "");
      const target = store
        .entitiesOfKind("Module")
        .find((m) => m.name === normalized || m.name.endsWith(`/${normalized}`));
      if (!target) {
        return {
          module: moduleQuery,
          exists: false,
          directDependents: [],
          transitiveDependents: [],
          unresolvedImports: store.unresolvedRelations("IMPORTS").length,
        };
      }
      // Direct dependents: modules that import the target directly, *or*
      // re-export it (a barrel one hop away from the target is a direct
      // dependent of it — see `dependentsOf`'s doc comment).
      const directRels = [...store.relationsTo(target.id, "IMPORTS"), ...store.relationsTo(target.id, "EXPORTS")];
      const direct = directRels.map((rel) => ({
        module: store.getEntity(rel.from)?.name ?? rel.from,
        specifier: String(rel.attributes.specifier ?? ""),
        location: rel.location!,
      }));

      const seen = new Set<string>([target.id]);
      const transitive: { module: string; depth: number }[] = [];
      let frontier = directRels.map((r) => r.from);
      for (const id of frontier) seen.add(id);
      for (let depth = 2; depth <= maxDepth && frontier.length > 0; depth += 1) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const rel of [...store.relationsTo(id, "IMPORTS"), ...store.relationsTo(id, "EXPORTS")]) {
            if (seen.has(rel.from)) continue;
            seen.add(rel.from);
            next.push(rel.from);
            transitive.push({ module: store.getEntity(rel.from)?.name ?? rel.from, depth });
          }
        }
        frontier = next;
      }

      return {
        module: target.name,
        exists: true,
        directDependents: direct,
        transitiveDependents: transitive,
        unresolvedImports: store.unresolvedRelations("IMPORTS").length,
      };
    },

    uncertainty: (store, result) => {
      const stale = store.unknownRegions("stale-index").length + store.unknownRegions("unparsed-file").length;
      const denominatorKnown = stale === 0 && result.exists;
      const totalImports = store.relationsOfKind("IMPORTS").length;
      const value = ratio(result.unresolvedImports, totalImports, denominatorKnown && totalImports > 0);
      return {
        components: {
          directDependents: result.directDependents.length,
          transitiveDependents: result.transitiveDependents.length,
          unresolvedImports: result.unresolvedImports,
          staleFiles: stale,
          denominatorKnown,
        },
        value,
        explanation: denominatorKnown
          ? `${result.unresolvedImports} of ${totalImports} import edges could not be resolved to an in-repository module (external packages count here)`
          : result.exists
            ? `denominator unknown (${stale} stale/unparsed file(s))`
            : `module ${moduleQuery} does not exist in the analyzed scope`,
      };
    },

    risk: (store) => riskFromUnknowns(store, ["stale-index", "unparsed-file", "missing-file", "generated-code"]),
  };
}

// ----------------------------------------------------------- ImportImpact

/**
 * ImportImpact: a *dependency* notion of impact — "what could observe a
 * change to this symbol's declaring module's exports" — independent of
 * whether anything on the path actually calls the changed symbol. This is
 * deliberately a separate mechanism from `ImpactOfChange` (reverse
 * CALLS/REFERENCES traversal): conflating the two hides which failure mode
 * is which (see arm.ts). Resolves the symbol to its declaring module, then
 * reuses the barrel-aware `dependentsOf` traversal.
 */
export interface ImportImpactResult {
  symbol: string;
  targets: TargetRef[];
  originModule: string | null;
  affectedFiles: string[];
  maxDepthReached: number;
  unresolvedImports: number;
}

export function importImpactTask(symbolQuery: string, maxDepth = 8): TaskDefinition<ImportImpactResult> {
  return {
    type: "ImportImpact",
    target: symbolQuery,
    requiredEvidence: ["import edge", "re-export edge", "resolved module target"],
    optionalEvidence: [],
    requiredAnalyses: ["ParseSource", "ResolveSymbols"],
    optionalAnalyses: [],
    threshold: 0.05,
    riskThreshold: 0,

    evaluate: (store) => {
      const targets = resolveTargets(store, symbolQuery);
      if (targets.length === 0) {
        return {
          symbol: symbolQuery,
          targets: [],
          originModule: null,
          affectedFiles: [],
          maxDepthReached: 0,
          unresolvedImports: store.unresolvedRelations("IMPORTS").length,
        };
      }
      const originFile = targets[0]!.location.file;
      const originModuleId = moduleIdFor(originFile);
      const { files, maxDepthReached } = dependentsOf(store, originModuleId, maxDepth);
      return {
        symbol: symbolQuery,
        targets,
        originModule: originFile,
        affectedFiles: files,
        maxDepthReached,
        unresolvedImports: store.unresolvedRelations("IMPORTS").length,
      };
    },

    uncertainty: (store, result) => {
      const stale = store.unknownRegions("stale-index").length + store.unknownRegions("unparsed-file").length;
      const denominatorKnown = stale === 0 && result.targets.length > 0;
      const totalImports = store.relationsOfKind("IMPORTS").length;
      const value = ratio(result.unresolvedImports, totalImports, denominatorKnown && totalImports > 0);
      return {
        components: {
          affectedFiles: result.affectedFiles.length,
          unresolvedImports: result.unresolvedImports,
          staleFiles: stale,
          denominatorKnown,
        },
        value,
        explanation: denominatorKnown
          ? `${result.unresolvedImports} of ${totalImports} import edges could not be resolved to an in-repository module (external packages count here)`
          : result.targets.length === 0
            ? `symbol ${symbolQuery} does not resolve to a declaration in the analyzed scope`
            : `denominator unknown (${stale} stale/unparsed file(s))`,
      };
    },

    risk: (store, result) => {
      const touchedFiles = new Set(result.affectedFiles);
      const base = riskFromUnknowns(store, ["stale-index", "unparsed-file", "missing-file", "generated-code"]);
      base.factors = base.factors.filter((f) => f.locations.length === 0 || f.locations.some((l) => touchedFiles.has(l.split(":")[0]!)));
      base.criticalSites = base.factors.reduce((n, f) => n + f.count, 0);
      base.acceptable = base.criticalSites === 0;
      if (result.maxDepthReached >= maxDepth) {
        base.factors.push({
          kind: "unsupported-syntax",
          count: 1,
          locations: [],
          detail: `dependency traversal hit the depth limit (${maxDepth}); deeper dependents were not enumerated`,
        });
        base.criticalSites += 1;
        base.acceptable = false;
      }
      base.explanation =
        base.criticalSites === 0 ? "no unproven region within the traversed modules affects this answer" : `${base.criticalSites} unproven site(s)`;
      return base;
    },
  };
}

/** Exposed for the report: proves the engine never shells out for task answers. */
export function gitIsAvailable(root: string): boolean {
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export type AnyTaskResult =
  | FindReferencesResult
  | ImpactOfChangeResult
  | WhichTestsResult
  | WhyChangedResult
  | ModuleDependentsResult;

export type { ResidualRisk, Uncertainty };
