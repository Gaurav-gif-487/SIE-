import { UnknownRegion } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";

/**
 * Shared task contract.
 *
 * Every task computes its own uncertainty and its own residual risk from
 * counted facts. There is no global confidence score in this engine, and no
 * task is allowed to return a number when the denominator is unknown: it must
 * return null and explain why.
 */

export interface Uncertainty {
  /** counted inputs to the uncertainty function; never estimated */
  components: Record<string, number | boolean>;
  /** null means UNKNOWN (denominator not established) */
  value: number | null;
  explanation: string;
}

export interface RiskFactor {
  kind: UnknownRegion["kind"] | "runtime-static-disagreement";
  count: number;
  locations: string[];
  detail: string;
}

export interface ResidualRisk {
  factors: RiskFactor[];
  /** counted risk sites; not a probability */
  criticalSites: number;
  acceptable: boolean;
  explanation: string;
}

export interface TaskDefinition<TResult> {
  type: string;
  target: string;
  requiredEvidence: string[];
  optionalEvidence: string[];
  /** analyses that must have run before the task can be answered at all */
  requiredAnalyses: string[];
  /** analyses that may reduce uncertainty or risk further */
  optionalAnalyses: string[];
  threshold: number;
  riskThreshold: number;
  evaluate: (store: KnowledgeStore) => TResult;
  uncertainty: (store: KnowledgeStore, result: TResult) => Uncertainty;
  risk: (store: KnowledgeStore, result: TResult) => ResidualRisk;
}

/** Risk built from unknown regions the store actually recorded. */
export function riskFromUnknowns(
  store: KnowledgeStore,
  kinds: UnknownRegion["kind"][],
  extra: RiskFactor[] = [],
): ResidualRisk {
  const factors: RiskFactor[] = [...extra];
  for (const kind of kinds) {
    const regions = store.unknownRegions(kind);
    if (regions.length === 0) continue;
    factors.push({
      kind,
      count: regions.length,
      locations: regions
        .filter((r) => r.location)
        .slice(0, 25)
        .map((r) => `${r.location!.file}:${r.location!.line}`),
      detail: regions[0]!.detail,
    });
  }
  const criticalSites = factors.reduce((n, f) => n + f.count, 0);
  return {
    factors,
    criticalSites,
    acceptable: criticalSites === 0,
    explanation:
      criticalSites === 0
        ? "no unproven region affects this answer"
        : `${criticalSites} unproven site(s): ${factors.map((f) => `${f.kind}=${f.count}`).join(", ")}`,
  };
}

/** UNKNOWN-safe ratio: returns null when the denominator is not established. */
export function ratio(numerator: number, denominator: number, denominatorKnown: boolean): number | null {
  if (!denominatorKnown || denominator <= 0) return null;
  return numerator / denominator;
}
