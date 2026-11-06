import { Evidence, Resolution, SourceLocation, UnknownRegion, formatLocation } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";

/**
 * Task layer.
 *
 * Uncertainty and risk are task-specific and computed from counted, observable
 * facts. There is no global confidence score anywhere in this engine.
 */

import { ResidualRisk, RiskFactor, TaskDefinition, Uncertainty } from "./task.js";
import { expandOverrides } from "./override-graph.js";
export type { ResidualRisk, RiskFactor, TaskDefinition, Uncertainty };

/** Counted inputs to the FindCallers uncertainty function. */
export interface UncertaintyComponents {
  resolvedCallSites: number;
  partialCallSites: number;
  ambiguousCallSites: number;
  unresolvedCallSites: number;
  conflictingEvidence: number;
  staleFiles: number;
  denominatorKnown: boolean;
}

// --------------------------------------------------------------- FindCallers

export type CallerClass = "confirmed" | "possible" | "unresolved-site" | "unsupported-region";

export interface CallerFinding {
  classification: CallerClass;
  callerName: string;
  callerId: string | null;
  callSite: SourceLocation;
  calleeText: string;
  targetSymbolId: string | null;
  resolution: Resolution;
  receiverType: string | null;
  risk: string | null;
  /** how the executed body relates to the queried declaration */
  dispatch: "direct" | "virtual-through-supertype" | "virtual-to-subtype" | "unestablished";
  evidenceIds: string[];
}


export interface FindCallersResult {
  symbol: string;
  /** every declaration in the repository the symbol name could refer to */
  targets: { id: string; name: string; container: string | null; location: SourceLocation }[];
  targetSelectionStatus: "RESOLVED" | "AMBIGUOUS" | "UNKNOWN";
  confirmed: CallerFinding[];
  possible: CallerFinding[];
  unresolvedSites: CallerFinding[];
  unsupportedRegions: UnknownRegion[];
  evidence: Evidence[];
}

function parseSymbolQuery(query: string): { container: string | null; name: string } {
  const idx = query.lastIndexOf(".");
  if (idx <= 0) return { container: null, name: query };
  return { container: query.slice(0, idx), name: query.slice(idx + 1) };
}

/**
 * FindCallers(symbol).
 *
 * Targets are the *declarations* matching the query. Callers are derived from
 * type-resolved CALLS relations - never from name matching alone. Call sites
 * whose target could not be established are reported separately so that a
 * consumer can see the boundary of the answer.
 */
export function findCallersTask(symbolQuery: string): TaskDefinition<FindCallersResult> {
  const { container, name } = parseSymbolQuery(symbolQuery);

  return {
    type: "FindCallers",
    target: symbolQuery,
    requiredEvidence: [
      "caller symbol",
      "call site file/line/column",
      "target symbol",
      "resolution status",
      "provenance",
    ],
    optionalEvidence: ["runtime traces", "tests", "coverage", "git history"],
    requiredAnalyses: ["ParseSource", "ResolveSymbols", "ResolveTypes", "AnalyzeInheritance", "ResolveCalls"],
    optionalAnalyses: ["BuildReferences", "IngestRuntimeTrace", "IngestCoverage", "AnalyzeGitHistory"],
    threshold: 0.05,
    riskThreshold: 0,

    evaluate: (store) => {
      const declarations = store
        .allEntities()
        .filter(
          (e) =>
            e.name === name &&
            ["Function", "Method", "Class", "Symbol"].includes(e.kind) &&
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

      // Virtual dispatch. A call the checker resolved to a *supertype*
      // declaration (interface method, base-class method) may execute the
      // queried override; a call resolved to the queried declaration may
      // execute a subtype override. Both directions come from the
      // EXTENDS/IMPLEMENTS graph (AnalyzeInheritance).
      const overrides = expandOverrides(store, targets);
      const supertypeIds = overrides.supertypeDecls;
      const subtypeIds = overrides.subtypeDecls;

      const confirmed: CallerFinding[] = [];
      const possible: CallerFinding[] = [];
      const unresolvedSites: CallerFinding[] = [];

      for (const rel of store.relationsOfKind("CALLS")) {
        if (!rel.location) continue;
        const candidates = String(rel.attributes.candidates ?? "")
          .split(",")
          .filter(Boolean);
        const calleeText = String(rel.attributes.calleeText ?? "");
        const calleeLast = calleeText.split(".").pop() ?? calleeText;
        const touched = [...candidates, ...(rel.to !== null ? [rel.to] : [])];
        const hitsTarget = touched.some((c) => targetIds.has(c));
        const hitsSupertype = touched.some((c) => supertypeIds.has(c));
        const hitsSubtype = touched.some((c) => subtypeIds.has(c));

        const finding: CallerFinding = {
          classification: "confirmed",
          callerName: String(rel.attributes.callerName ?? "<unknown>"),
          callerId: rel.from.startsWith("File:") ? null : rel.from,
          callSite: rel.location,
          calleeText,
          targetSymbolId: rel.to,
          resolution: rel.resolution,
          receiverType: (rel.attributes.receiverType as string | null) ?? null,
          risk: (rel.attributes.risk as string | null) ?? null,
          dispatch: hitsTarget
            ? "direct"
            : hitsSupertype
              ? "virtual-through-supertype"
              : hitsSubtype
                ? "virtual-to-subtype"
                : "unestablished",
          evidenceIds: store.evidenceFor(rel.id).map((e) => e.id),
        };

        // A computed / reflective callee has no statically established target.
        // Even when the checker happened to return a declaration, the site is
        // reported as an open site rather than a caller: claiming it would be a
        // guess, and hiding it would understate the answer's boundary.
        const dynamicSite =
          rel.attributes.risk === "dynamic-dispatch" || rel.attributes.risk === "reflection";

        if (dynamicSite && (hitsTarget || hitsSupertype || hitsSubtype || calleeLast === name)) {
          unresolvedSites.push({ ...finding, classification: "unresolved-site", dispatch: "unestablished" });
        } else if (hitsTarget && rel.resolution === Resolution.EXACT) {
          confirmed.push(finding);
        } else if (hitsTarget || hitsSupertype || hitsSubtype) {
          possible.push({ ...finding, classification: "possible" });
        } else if (
          (rel.resolution === Resolution.UNRESOLVED || rel.attributes.risk === "dynamic-dispatch") &&
          calleeLast === name
        ) {
          // name matches but nothing was established: explicitly an open site,
          // NOT a caller. This is the difference from grep-based tools.
          unresolvedSites.push({ ...finding, classification: "unresolved-site" });
        }
      }


      const unsupportedRegions = store
        .unknownRegions()
        .filter((u) =>
          ["dynamic-dispatch", "reflection", "generated-code", "unsupported-syntax", "unparsed-file", "missing-file"].includes(
            u.kind,
          ),
        );

      const evidenceIds = new Set(
        [...confirmed, ...possible, ...unresolvedSites].flatMap((f) => f.evidenceIds),
      );
      const evidence = store.allEvidence().filter((e) => evidenceIds.has(e.id));

      return {
        symbol: symbolQuery,
        targets,
        targetSelectionStatus:
          targets.length === 1 ? "RESOLVED" : targets.length > 1 ? "AMBIGUOUS" : "UNKNOWN",
        confirmed,
        possible,
        unresolvedSites,
        unsupportedRegions,
        evidence,
      };
    },

    uncertainty: (store, result) => {
      const resolved = result.confirmed.length;
      const partial = result.possible.filter((p) => p.resolution === Resolution.PARTIAL).length;
      const ambiguous = result.possible.filter((p) => p.resolution === Resolution.AMBIGUOUS).length;
      const unresolved = result.unresolvedSites.length;
      const conflicting = store.conflicts().length;
      const staleFiles = store.unknownRegions("stale-index").length + store.unknownRegions("unparsed-file").length;
      // The denominator is the set of call sites that could plausibly reach the
      // target: established hits plus open sites. It is only known when the
      // repository parsed completely and no file is stale.
      const denominatorKnown = staleFiles === 0 && result.targets.length > 0;
      const total = resolved + partial + ambiguous + unresolved;
      const components = {
        resolvedCallSites: resolved,
        partialCallSites: partial,
        ambiguousCallSites: ambiguous,
        unresolvedCallSites: unresolved,
        conflictingEvidence: conflicting,
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
      const value = (partial + ambiguous + unresolved + conflicting) / total;
      return {
        components,
        value,
        explanation: `(${partial} partial + ${ambiguous} ambiguous + ${unresolved} unresolved + ${conflicting} conflicting) / ${total} candidate sites`,
      };
    },

    risk: (store, result) => {
      const factors: RiskFactor[] = [];
      const relevantKinds: UnknownRegion["kind"][] = [
        "dynamic-dispatch",
        "reflection",
        "generated-code",
        "unsupported-syntax",
        "missing-file",
        "unparsed-file",
        "stale-index",
      ];
      for (const kind of relevantKinds) {
        const regions = store.unknownRegions(kind);
        if (regions.length === 0) continue;
        factors.push({
          kind,
          count: regions.length,
          locations: regions.slice(0, 10).map((r) => (r.location ? formatLocation(r.location) : "<repository>")),
          detail: regions[0]!.detail,
        });
      }
      const conflicts = store.conflicts();
      if (conflicts.length > 0) {
        factors.push({
          kind: "runtime-static-disagreement",
          count: conflicts.length,
          locations: conflicts.slice(0, 10).map((c) => c.subject),
          detail: "evidence sources disagree; both records retained as CONFLICTING",
        });
      }
      // Only risk sites that can actually affect this task's answer count as critical:
      // open call sites bearing the target's name, plus conflicts.
      const criticalSites =
        result.unresolvedSites.filter((s) => s.risk === "dynamic-dispatch" || s.risk === "reflection").length +
        conflicts.length;
      return {
        factors,
        criticalSites,
        acceptable: criticalSites === 0,
        explanation:
          criticalSites === 0
            ? "no dynamic-dispatch, reflection or conflicting site can reach the target"
            : `${criticalSites} site(s) could reach the target without static proof`,
      };
    },
  };
}
