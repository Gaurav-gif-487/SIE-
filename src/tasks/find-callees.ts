import { Evidence, Resolution, SourceLocation, UnknownRegion, formatLocation } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { ResidualRisk, RiskFactor, TaskDefinition, Uncertainty } from "./task.js";
import { implementationsOf } from "./override-graph.js";
import { resolveTargets } from "./queries.js";

/**
 * FindCallees(symbol): what can this function execute?
 *
 * The mirror image of FindCallers, and it needs the *opposite* inheritance
 * direction: a call site inside the body resolves to one declaration, but if
 * that declaration is an interface member or an abstract method, the body that
 * runs is one of its implementations. Those are reported as `possible`, the
 * statically pinned ones as `confirmed`, and computed / reflective callees as
 * open sites rather than guesses.
 */

export type CalleeClass = "confirmed" | "possible" | "unresolved-site";

export interface CalleeFinding {
  classification: CalleeClass;
  calleeName: string;
  calleeId: string | null;
  calleeText: string;
  callSite: SourceLocation;
  resolution: Resolution;
  receiverType: string | null;
  risk: string | null;
  dispatch: "direct" | "virtual-to-implementation" | "unestablished";
  /** the declaration the checker resolved, when the finding is an implementation */
  viaDeclaration: string | null;
  evidenceIds: string[];
}

export interface FindCalleesResult {
  symbol: string;
  targets: { id: string; name: string; container: string | null; location: SourceLocation }[];
  targetSelectionStatus: "RESOLVED" | "AMBIGUOUS" | "UNKNOWN";
  confirmed: CalleeFinding[];
  possible: CalleeFinding[];
  unresolvedSites: CalleeFinding[];
  /** callees outside the repository (node builtins, dependencies) */
  externalCallees: { text: string; callSite: SourceLocation }[];
  unsupportedRegions: UnknownRegion[];
  evidence: Evidence[];
}

export function findCalleesTask(symbolQuery: string): TaskDefinition<FindCalleesResult> {
  return {
    type: "FindCallees",
    target: symbolQuery,
    requiredEvidence: ["enclosing caller of each call site", "resolved callee declaration", "resolution status", "provenance"],
    optionalEvidence: ["runtime traces", "coverage"],
    requiredAnalyses: ["ParseSource", "ResolveSymbols", "ResolveTypes", "AnalyzeInheritance", "ResolveCalls"],
    optionalAnalyses: ["BuildReferences", "IngestRuntimeTrace", "IngestCoverage"],
    threshold: 0.05,
    riskThreshold: 0,

    evaluate: (store) => {
      const targets = resolveTargets(store, symbolQuery)
        .filter((t) => ["Function", "Method", "Symbol"].includes(t.kind))
        .map((t) => ({ id: t.id, name: t.name, container: t.container, location: t.location }));
      const targetIds = new Set(targets.map((t) => t.id));

      const confirmed: CalleeFinding[] = [];
      const possible: CalleeFinding[] = [];
      const unresolvedSites: CalleeFinding[] = [];
      const externalCallees: { text: string; callSite: SourceLocation }[] = [];

      for (const rel of store.relationsOfKind("CALLS")) {
        if (!rel.location) continue;
        if (!targetIds.has(rel.from)) continue; // only calls *inside* the queried body
        const calleeText = String(rel.attributes.calleeText ?? "");
        const dynamicSite = rel.attributes.risk === "dynamic-dispatch" || rel.attributes.risk === "reflection";
        const candidates = String(rel.attributes.candidates ?? "").split(",").filter(Boolean);
        const resolvedIds = [...new Set([...(rel.to ? [rel.to] : []), ...candidates])];

        const base = {
          calleeText,
          callSite: rel.location,
          resolution: rel.resolution,
          receiverType: (rel.attributes.receiverType as string | null) ?? null,
          risk: (rel.attributes.risk as string | null) ?? null,
          evidenceIds: store.evidenceFor(rel.id).map((e) => e.id),
        };

        if (dynamicSite || resolvedIds.length === 0) {
          if (!dynamicSite && rel.resolution === Resolution.EXACT) {
            // resolved, but to something the repository does not declare
            externalCallees.push({ text: calleeText, callSite: rel.location });
            continue;
          }
          unresolvedSites.push({
            ...base,
            classification: "unresolved-site",
            calleeName: calleeText,
            calleeId: null,
            dispatch: "unestablished",
            viaDeclaration: null,
          });
          continue;
        }

        for (const id of resolvedIds) {
          const entity = store.getEntity(id);
          if (!entity) continue;
          const finding: CalleeFinding = {
            ...base,
            classification: "confirmed",
            calleeName: entity.attributes.container
              ? `${String(entity.attributes.container)}.${entity.name}`
              : entity.name,
            calleeId: entity.id,
            dispatch: "direct",
            viaDeclaration: null,
          };
          const bodyless =
            Boolean(entity.attributes.abstract) || Boolean(entity.attributes.declarationOnly);
          if (rel.resolution === Resolution.EXACT && resolvedIds.length === 1 && !bodyless) {
            confirmed.push(finding);
          } else {
            possible.push({ ...finding, classification: "possible" });
          }

          // virtual dispatch: implementations of the resolved declaration
          const impls = implementationsOf(store, {
            id: entity.id,
            name: entity.name,
            container: (entity.attributes.container as string | null) ?? null,
          });
          for (const implId of impls.ids) {
            const impl = store.getEntity(implId);
            if (!impl) continue;
            possible.push({
              ...base,
              classification: "possible",
              calleeName: impl.attributes.container
                ? `${String(impl.attributes.container)}.${impl.name}`
                : impl.name,
              calleeId: impl.id,
              dispatch: "virtual-to-implementation",
              viaDeclaration: finding.calleeName,
            });
          }
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

      return {
        symbol: symbolQuery,
        targets,
        targetSelectionStatus:
          targets.length === 1 ? "RESOLVED" : targets.length > 1 ? "AMBIGUOUS" : "UNKNOWN",
        confirmed,
        possible,
        unresolvedSites,
        externalCallees,
        unsupportedRegions,
        evidence: store.allEvidence().filter((e) => evidenceIds.has(e.id)),
      };
    },

    uncertainty: (store, result): Uncertainty => {
      const resolved = result.confirmed.length;
      const virtual = result.possible.length;
      const unresolved = result.unresolvedSites.length;
      const staleFiles =
        store.unknownRegions("stale-index").length + store.unknownRegions("unparsed-file").length;
      const denominatorKnown = staleFiles === 0 && result.targets.length > 0;
      const total = resolved + virtual + unresolved;
      const components = {
        resolvedCallSites: resolved,
        partialCallSites: virtual,
        ambiguousCallSites: 0,
        unresolvedCallSites: unresolved,
        conflictingEvidence: store.conflicts().length,
        staleFiles,
        denominatorKnown,
      };
      if (!denominatorKnown || total === 0) {
        return {
          components,
          value: null,
          explanation: denominatorKnown
            ? "the queried body contains no candidate call site; the denominator is zero"
            : `denominator unknown (${staleFiles} stale/unparsed file(s), ${result.targets.length} target declaration(s))`,
        };
      }
      return {
        components,
        value: (virtual + unresolved) / total,
        explanation: `(${virtual} virtual/partial + ${unresolved} unresolved) / ${total} outgoing call resolutions`,
      };
    },

    risk: (store, result): ResidualRisk => {
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
      // Same fix as FindCallers (see docs/verification-layer.md):
      // only risk sites that can actually affect *this query's* answer count as critical —
      // open call sites inside the queried body, plus store-wide conflicts. A repo-wide
      // `riskFromUnknowns` scan (the prior behavior here) made every FindCallees query
      // trigger verification the moment any file anywhere used dynamic dispatch/reflection,
      // regardless of whether the queried symbol's body ever touched it.
      const criticalSites =
        result.unresolvedSites.filter((s) => s.risk === "dynamic-dispatch" || s.risk === "reflection").length +
        conflicts.length;
      // External callees are a boundary of the answer, not an unproven site:
      // they are reported in the result, and counted here in the explanation.
      return {
        factors,
        criticalSites,
        acceptable: criticalSites === 0,
        explanation:
          (criticalSites === 0
            ? "no dynamic-dispatch, reflection or conflicting site can reach the target"
            : `${criticalSites} site(s) could reach the target without static proof`) +
          (result.externalCallees.length > 0
            ? `; ${result.externalCallees.length} callee(s) declared outside the analyzed repository`
            : ""),
      };
    },
  };
}
