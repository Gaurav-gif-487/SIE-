import { Evidence, Resolution, SourceLocation, UnknownRegion, formatLocation } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { ResidualRisk, RiskFactor, TaskDefinition, Uncertainty } from "./task.js";

/**
 * FindPythonCallers(symbol).
 *
 * Deliberately a separate task from FindCallers, not a shared generic: the
 * Python acquisition pipeline (`src/acquisition/python.ts`) is name-based
 * only — no type checker backs it — so its CALLS resolution can never reach
 * Resolution.EXACT the way `ts.TypeChecker` can. Reusing `CallerClass`'s
 * "confirmed" bucket here would silently overstate what this engine can
 * stand behind for Python. The three buckets below are the honest ceiling:
 *
 *   possible         - exactly one repo-wide declaration name-matches the
 *                       call site (Resolution.PARTIAL) and it is (or could
 *                       be, via a container match) the queried target
 *   ambiguous         - multiple declarations name-match; the queried target
 *                       is among the candidates but so are others
 *   unresolved-site   - the call's callee text matches the queried symbol's
 *                       name but no declaration in-repo name-matched it at
 *                       all (builtin, stdlib, third-party, or dynamic)
 *
 * There is no dispatch/virtual-call analysis here (no EXTENDS-based
 * override expansion, unlike FindCallers): the Python acquisition layer
 * does not currently resolve class inheritance, so "which subtype actually
 * runs" is not a claim this task can make.
 */

export type PythonCallerClass = "possible" | "ambiguous" | "unresolved-site";

export interface PythonCallerFinding {
  classification: PythonCallerClass;
  callerName: string;
  callerId: string | null;
  callSite: SourceLocation;
  calleeText: string;
  targetSymbolId: string | null;
  resolution: Resolution;
  isAttribute: boolean;
  /** how many in-repo declarations this call's name matched, total */
  candidateCount: number;
  evidenceIds: string[];
}

export interface FindPythonCallersResult {
  symbol: string;
  targets: { id: string; name: string; container: string | null; location: SourceLocation }[];
  targetSelectionStatus: "RESOLVED" | "AMBIGUOUS" | "UNKNOWN";
  possible: PythonCallerFinding[];
  ambiguous: PythonCallerFinding[];
  unresolvedSites: PythonCallerFinding[];
  unsupportedRegions: UnknownRegion[];
  evidence: Evidence[];
}

function parseSymbolQuery(query: string): { container: string | null; name: string } {
  const idx = query.lastIndexOf(".");
  if (idx <= 0) return { container: null, name: query };
  return { container: query.slice(0, idx), name: query.slice(idx + 1) };
}

export function findPythonCallersTask(symbolQuery: string): TaskDefinition<FindPythonCallersResult> {
  const { container, name } = parseSymbolQuery(symbolQuery);

  return {
    type: "FindPythonCallers",
    target: symbolQuery,
    requiredEvidence: ["caller symbol", "call site file/line/column", "target symbol name-match", "provenance"],
    optionalEvidence: [],
    requiredAnalyses: ["ParsePythonSource", "ResolvePythonSymbols", "ResolvePythonCalls"],
    optionalAnalyses: [],
    threshold: 0.05,
    riskThreshold: 0,

    evaluate: (store) => {
      const declarations = store
        .allEntities()
        .filter(
          (e) =>
            e.name === name &&
            ["Function", "Method", "Class"].includes(e.kind) &&
            e.attributes.language === "python" &&
            (container === null || String(e.attributes.container ?? "") === container),
        );

      const targets = declarations
        .filter((d) => d.location)
        .map((d) => ({
          id: d.id,
          name: d.name,
          container: (d.attributes.container as string | null) ?? null,
          location: d.location!,
        }));

      const targetIds = new Set(targets.map((t) => t.id));

      const possible: PythonCallerFinding[] = [];
      const ambiguous: PythonCallerFinding[] = [];
      const unresolvedSites: PythonCallerFinding[] = [];

      for (const rel of store.relationsOfKind("CALLS")) {
        if (!rel.location) continue;
        if (rel.attributes.builtin) continue;
        const calleeText = String(rel.attributes.calleeText ?? "");
        const calleeLast = calleeText.split(".").pop() ?? calleeText;
        if (calleeLast !== name) continue; // not a candidate site for this symbol at all

        const candidateIds = String(rel.attributes.candidates ?? "")
          .split(",")
          .filter(Boolean);
        const touchesTarget = (rel.to !== null && targetIds.has(rel.to)) || candidateIds.some((c) => targetIds.has(c));

        const callerEntity = rel.from.startsWith("Module:") ? null : store.getEntity(rel.from);

        const finding: PythonCallerFinding = {
          classification: "possible",
          callerName: callerEntity?.name ?? String(rel.from).replace(/^Module:py:/, ""),
          callerId: callerEntity?.id ?? null,
          callSite: rel.location,
          calleeText,
          targetSymbolId: rel.to,
          resolution: rel.resolution,
          isAttribute: Boolean(rel.attributes.isAttribute),
          candidateCount: Number(rel.attributes.candidateCount ?? 0),
          evidenceIds: store.evidenceFor(rel.id).map((e) => e.id),
        };

        if (rel.resolution === Resolution.PARTIAL && touchesTarget) {
          possible.push(finding);
        } else if (rel.resolution === Resolution.AMBIGUOUS && touchesTarget) {
          ambiguous.push({ ...finding, classification: "ambiguous" });
        } else if (rel.resolution === Resolution.UNRESOLVED) {
          // name matches the query but nothing in-repo name-matched the
          // call site itself: an open site, not a caller.
          unresolvedSites.push({ ...finding, classification: "unresolved-site" });
        }
        // A PARTIAL/AMBIGUOUS call whose name matches but whose (candidate)
        // ids don't touch this target is a real call to a *different*,
        // same-named declaration outside the queried container — correctly
        // not reported here at all, the same boundary FindCallers draws.
      }

      const unsupportedRegions = store
        .unknownRegions()
        .filter((u) => ["unparsed-file", "missing-file", "unsupported-syntax"].includes(u.kind));

      const evidenceIds = new Set([...possible, ...ambiguous, ...unresolvedSites].flatMap((f) => f.evidenceIds));
      const evidence = store.allEvidence().filter((e) => evidenceIds.has(e.id));

      return {
        symbol: symbolQuery,
        targets,
        targetSelectionStatus: targets.length === 1 ? "RESOLVED" : targets.length > 1 ? "AMBIGUOUS" : "UNKNOWN",
        possible,
        ambiguous,
        unresolvedSites,
        unsupportedRegions,
        evidence,
      };
    },

    uncertainty: (store, result) => {
      const resolved = result.possible.length;
      const ambiguousCount = result.ambiguous.length;
      const unresolved = result.unresolvedSites.length;
      const staleFiles = store.unknownRegions("stale-index").length + store.unknownRegions("unparsed-file").length;
      const denominatorKnown = staleFiles === 0 && result.targets.length > 0;
      const total = resolved + ambiguousCount + unresolved;
      const components = {
        resolvedCallSites: resolved,
        ambiguousCallSites: ambiguousCount,
        unresolvedCallSites: unresolved,
        staleFiles,
        denominatorKnown,
      };
      if (!denominatorKnown || total === 0) {
        return {
          components,
          value: null,
          explanation: denominatorKnown
            ? "no candidate call site was found; the denominator is zero so a ratio is undefined"
            : `denominator unknown (${staleFiles} stale/unparsed file(s), ${result.targets.length} target declaration(s))`,
        };
      }
      const value = (ambiguousCount + unresolved) / total;
      return {
        components,
        value,
        explanation: `(${ambiguousCount} ambiguous + ${unresolved} unresolved) / ${total} name-matched call sites`,
      };
    },

    risk: (store, result) => {
      const factors: RiskFactor[] = [];
      // Every AMBIGUOUS call site touching the target is itself the
      // critical risk here: unlike FindCallers, there is no type checker to
      // ever close this out for Python, so it is reported per-task rather
      // than pulled from global unknownRegions("dynamic-dispatch"/etc.),
      // which don't apply to this heuristic, type-checker-free pipeline.
      if (result.ambiguous.length > 0) {
        factors.push({
          kind: "ambiguous-call",
          count: result.ambiguous.length,
          locations: result.ambiguous.slice(0, 10).map((a) => formatLocation(a.callSite)),
          detail: "name-based resolution only; no type information to disambiguate which declaration actually runs",
        });
      }
      const relevantUnknownKinds: UnknownRegion["kind"][] = ["unparsed-file", "missing-file"];
      for (const kind of relevantUnknownKinds) {
        const regions = store.unknownRegions(kind);
        if (regions.length === 0) continue;
        factors.push({
          kind,
          count: regions.length,
          locations: regions.slice(0, 10).map((r) => (r.location ? formatLocation(r.location) : "<repository>")),
          detail: regions[0]!.detail,
        });
      }
      const criticalSites = result.ambiguous.length + factors.filter((f) => f.kind !== "ambiguous-call").reduce((n, f) => n + f.count, 0);
      return {
        factors,
        criticalSites,
        acceptable: criticalSites === 0,
        explanation:
          criticalSites === 0
            ? "no ambiguous or unparsed site can reach the target"
            : `${criticalSites} site(s) could reach the target without a firm (single-candidate) name match`,
      };
    },
  };
}
