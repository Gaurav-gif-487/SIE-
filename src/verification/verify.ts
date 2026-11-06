import { KnowledgeStore } from "../knowledge/store.js";
import { TaskDefinition } from "../tasks/task.js";
import { analysisByName } from "../analyses/library.js";
import { PlanOutcome } from "../planning/planner.js";
import { Soundness } from "../canonical/model.js";
import {
  DEFAULT_VERIFICATION_POLICY,
  TaskCriticality,
  VerificationDecision,
  VerificationPolicyConfig,
  decideVerification,
  weakestSoundness,
} from "./policy.js";
import { ChallengeOutcome, challengeFindCallees, challengeFindCallers, challengeFindReferences, challengeModuleDependents, challengeWhichTestsExercise } from "./challenge.js";
import { EvidenceComparison, compareEvidence } from "./compare.js";
import { FindCallersResult } from "../tasks/find-callers.js";
import { FindCalleesResult } from "../tasks/find-callees.js";
import { FindReferencesResult, ImpactOfChangeResult, ModuleDependentsResult, WhichTestsResult } from "../tasks/queries.js";

/**
 * A query's final, risk-aware status. Distinct from `PlanOutcome.verdict`
 * (which only reflects the primary path): this also folds in what the
 * independent challenge found, when one ran. A conflict — from either the
 * primary path's own evidence or the challenge disagreeing with it — is
 * never converted into RESOLVED or RESOLVED_WITH_VERIFICATION.
 */
export type FinalStatus =
  | "RESOLVED"
  | "RESOLVED_WITH_VERIFICATION"
  | "PARTIAL"
  | "CONFLICTING"
  | "HIGH_RESIDUAL_RISK"
  | "INSUFFICIENT_EVIDENCE";

export interface VerificationRecord {
  decision: VerificationDecision;
  ran: boolean;
  challenge: ChallengeOutcome | null;
  comparison: EvidenceComparison | null;
}

export interface VerifiedPlanOutcome<TResult> extends PlanOutcome<TResult> {
  verification: VerificationRecord;
  finalStatus: FinalStatus;
}

export interface VerifyOptions {
  criticality?: TaskCriticality;
  policy?: VerificationPolicyConfig;
  /** run the challenge when the policy says "recommended", not only "required". Default true. */
  autoVerifyRecommended?: boolean;
}

function analysisSoundnesses<TResult>(task: TaskDefinition<TResult>, store: KnowledgeStore): Soundness[] {
  const relevant = new Set([...task.requiredAnalyses, ...task.optionalAnalyses]);
  const completed = new Set(store.completedAnalyses());
  return [...relevant].filter((n) => completed.has(n)).map((n) => analysisByName(n).soundness);
}

export function classifyFinalStatus(outcome: PlanOutcome<unknown>, verification: VerificationRecord): FinalStatus {
  if (outcome.verdict === "CONFLICTING_EVIDENCE") return "CONFLICTING";
  if (
    verification.comparison &&
    (verification.comparison.outcome === "CONTRADICTED" || verification.comparison.outcome === "CONFLICTING")
  ) {
    return "CONFLICTING";
  }
  if (outcome.verdict === "HIGH_RESIDUAL_RISK") return "HIGH_RESIDUAL_RISK";
  if (outcome.verdict === "INSUFFICIENT_EVIDENCE" || outcome.verdict === "ANALYSIS_UNSUPPORTED") {
    return "INSUFFICIENT_EVIDENCE";
  }
  // outcome.verdict === "SUFFICIENT" from here down.
  if (
    verification.ran &&
    verification.comparison &&
    (verification.comparison.outcome === "CONFIRMED" || verification.comparison.outcome === "PARTIALLY_CONFIRMED")
  ) {
    return "RESOLVED_WITH_VERIFICATION";
  }
  if (!verification.ran) return "RESOLVED";
  // Verification ran but produced no decisive comparison (both empty, or the
  // challenge mechanism itself was unavailable): the primary answer stands,
  // but it was not actually corroborated, so it is not RESOLVED outright.
  return "PARTIAL";
}

function runVerification<TResult>(
  outcome: PlanOutcome<TResult>,
  store: KnowledgeStore,
  task: TaskDefinition<TResult>,
  primarySites: string[],
  unresolvedSiteCount: number,
  targetScopedRisk: { hasDynamicDispatch: boolean; hasReflection: boolean },
  runChallenge: () => ChallengeOutcome,
  options: VerifyOptions,
): VerifiedPlanOutcome<TResult> {
  const criticality = options.criticality ?? "normal";
  const config = options.policy ?? DEFAULT_VERIFICATION_POLICY;
  const autoVerifyRecommended = options.autoVerifyRecommended ?? true;

  const decision = decideVerification(
    {
      criticality,
      residualRiskSites: outcome.risk.criticalSites,
      // Conflicts (EvidenceStatus.CONFLICTING) are counted store-wide, same
      // as the primary task's own risk.criticalSites formula does — but
      // dynamic-dispatch/reflection are read from *this query's own*
      // unresolved sites, not from risk.factors (which lists every such
      // region in the whole repository, most of them irrelevant to this
      // symbol). Using the repo-wide list here would make verification
      // "required" for nearly every query the moment any file anywhere
      // uses `.call`/`.bind`/computed access — exactly the unnecessary
      // over-verification the policy is supposed to avoid.
      hasConflictingEvidence: store.conflicts().length > 0,
      hasDynamicDispatch: targetScopedRisk.hasDynamicDispatch,
      hasReflection: targetScopedRisk.hasReflection,
      hasIncompleteCoverage: store.unknownRegions("no-coverage-data").length > 0,
      unresolvedSiteCount,
      weakestSoundness: weakestSoundness(analysisSoundnesses(task, store)),
    },
    config,
  );

  const shouldRun = decision.level === "required" || (decision.level === "recommended" && autoVerifyRecommended);
  if (!shouldRun) {
    const verification: VerificationRecord = { decision, ran: false, challenge: null, comparison: null };
    return { ...outcome, verification, finalStatus: classifyFinalStatus(outcome, verification) };
  }

  const challenge = runChallenge();
  const comparison = challenge.unavailableReason === null ? compareEvidence(primarySites, challenge.sites) : null;
  const verification: VerificationRecord = { decision, ran: true, challenge, comparison };
  return { ...outcome, verification, finalStatus: classifyFinalStatus(outcome, verification) };
}

function siteKey(file: string, line: number): string {
  return `${file}:${line}`;
}

export function verifyFindCallers(
  outcome: PlanOutcome<FindCallersResult>,
  store: KnowledgeStore,
  task: TaskDefinition<FindCallersResult>,
  root: string,
  symbol: string,
  options: VerifyOptions = {},
): VerifiedPlanOutcome<FindCallersResult> {
  const primarySites = [...outcome.result.confirmed, ...outcome.result.possible].map((f) =>
    siteKey(f.callSite.file, f.callSite.line),
  );
  const targetScopedRisk = {
    hasDynamicDispatch: outcome.result.unresolvedSites.some((s) => s.risk === "dynamic-dispatch"),
    hasReflection: outcome.result.unresolvedSites.some((s) => s.risk === "reflection"),
  };
  return runVerification(
    outcome,
    store,
    task,
    primarySites,
    outcome.result.unresolvedSites.length,
    targetScopedRisk,
    () => challengeFindCallers(root, symbol, store.revision),
    options,
  );
}

export function verifyFindCallees(
  outcome: PlanOutcome<FindCalleesResult>,
  store: KnowledgeStore,
  task: TaskDefinition<FindCalleesResult>,
  root: string,
  symbol: string,
  options: VerifyOptions = {},
): VerifiedPlanOutcome<FindCalleesResult> {
  const primarySites = [...outcome.result.confirmed, ...outcome.result.possible].map((f) =>
    siteKey(f.callSite.file, f.callSite.line),
  );
  const targetScopedRisk = {
    hasDynamicDispatch: outcome.result.unresolvedSites.some((s) => s.risk === "dynamic-dispatch"),
    hasReflection: outcome.result.unresolvedSites.some((s) => s.risk === "reflection"),
  };
  return runVerification(
    outcome,
    store,
    task,
    primarySites,
    outcome.result.unresolvedSites.length,
    targetScopedRisk,
    () => challengeFindCallees(root, symbol, store.revision),
    options,
  );
}

// -------------------------------------------------------- FindReferences

export function verifyFindReferences(
  outcome: PlanOutcome<FindReferencesResult>,
  store: KnowledgeStore,
  task: TaskDefinition<FindReferencesResult>,
  root: string,
  symbol: string,
  options: VerifyOptions = {},
): VerifiedPlanOutcome<FindReferencesResult> {
  const primarySites = outcome.result.references.map((f) => siteKey(f.location.file, f.location.line));
  // FindReferences has no per-site "dynamic-dispatch"/"reflection" risk
  // classification the way FindCallers/FindCallees do (a reference is a
  // reference, not a resolved-or-not call target); the ambiguous count and
  // unresolvedNameMatches are the closest query-scoped risk signals.
  const targetScopedRisk = { hasDynamicDispatch: false, hasReflection: false };
  return runVerification(
    outcome,
    store,
    task,
    primarySites,
    outcome.result.ambiguous.length + outcome.result.unresolvedNameMatches,
    targetScopedRisk,
    () => challengeFindReferences(root, symbol, store.revision),
    options,
  );
}

// ------------------------------------------------------- ModuleDependents

export function verifyModuleDependents(
  outcome: PlanOutcome<ModuleDependentsResult>,
  store: KnowledgeStore,
  task: TaskDefinition<ModuleDependentsResult>,
  root: string,
  moduleQuery: string,
  options: VerifyOptions = {},
): VerifiedPlanOutcome<ModuleDependentsResult> {
  const primarySites = outcome.result.directDependents.map((d) => siteKey(d.location.file, d.location.line));
  const targetScopedRisk = { hasDynamicDispatch: false, hasReflection: false };
  return runVerification(
    outcome,
    store,
    task,
    primarySites,
    outcome.result.unresolvedImports,
    targetScopedRisk,
    () => challengeModuleDependents(root, moduleQuery, store.revision),
    options,
  );
}

// ----------------------------------------------------- WhichTestsExercise

/**
 * Unlike the other `verify*` functions, this compares at file granularity,
 * not file:line: `WhichTestsResult.statically` findings (`tasks/queries.ts`)
 * carry a test file but not a source position, so a line-level `siteKey`
 * would never agree even when the two mechanisms found the same test file.
 * Only the *statically* evidenced findings are challenged — runtime
 * (coverage/stack-trace) findings are already independent, observational
 * evidence and are not re-challenged (see `challengeWhichTestsExercise`'s
 * doc comment).
 */
export function verifyWhichTestsExercise(
  outcome: PlanOutcome<WhichTestsResult>,
  store: KnowledgeStore,
  task: TaskDefinition<WhichTestsResult>,
  root: string,
  symbol: string,
  options: VerifyOptions = {},
): VerifiedPlanOutcome<WhichTestsResult> {
  const primarySites = [...new Set(outcome.result.statically.map((f) => f.file))].sort();
  const targetScopedRisk = { hasDynamicDispatch: false, hasReflection: false };
  return runVerification(
    outcome,
    store,
    task,
    primarySites,
    0,
    targetScopedRisk,
    () => {
      const raw = challengeWhichTestsExercise(root, symbol, store.revision);
      // reduce file:line sites to file-only sites to match primarySites' granularity
      const fileSites = [...new Set(raw.sites.map((s) => s.split(":")[0]!))].sort();
      return { ...raw, sites: fileSites };
    },
    options,
  );
}

// -------------------------------------------------------------- ImpactOfChange

/**
 * Reuses `challengeFindReferences` rather than adding a fourth near-duplicate
 * AST walk: ImpactOfChange's depth-1 (`direct`) dependents are, by
 * definition, "who references the target symbol directly" — the same
 * question FindReferences answers. Only that depth-1 layer is compared.
 * Transitive layers (depth ≥ 2) are NOT independently challenged: doing so
 * would mean walking the *challenge's own* reference graph outward
 * recursively, which is a materially different, unbuilt mechanism, not a
 * documentation gap — see docs/verification-layer.md for why this is
 * left as an explicit limitation rather than a fabricated transitive
 * challenge.
 */
export function verifyImpactOfChange(
  outcome: PlanOutcome<ImpactOfChangeResult>,
  store: KnowledgeStore,
  task: TaskDefinition<ImpactOfChangeResult>,
  root: string,
  symbol: string,
  options: VerifyOptions = {},
): VerifiedPlanOutcome<ImpactOfChangeResult> {
  const directEdges = outcome.result.edges.filter((e) => e.depth === 1);
  const primarySites = directEdges.map((e) => siteKey(e.location.file, e.location.line));
  const targetScopedRisk = { hasDynamicDispatch: false, hasReflection: false };
  return runVerification(
    outcome,
    store,
    task,
    primarySites,
    outcome.result.openEdges,
    targetScopedRisk,
    () => {
      const raw = challengeFindReferences(root, symbol, store.revision);
      return {
        ...raw,
        method: `${raw.method} (depth-1 only)`,
      };
    },
    options,
  );
}
