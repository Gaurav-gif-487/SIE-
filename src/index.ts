/**
 * Programmatic SDK entry point.
 *
 * This package ships as TypeScript source and runs via `tsx` (see
 * package.json's `bin`/scripts) rather than a compiled `dist/`; there is no
 * separate build step today, so this entry point re-exports directly from
 * `src/`. A consumer importing this package gets the same source the CLI,
 * daemon, and MCP server run, not a parallel compiled artifact that could
 * drift from it.
 *
 * Typical usage:
 *
 *   import { Engine } from "software-intelligence-engine";
 *
 *   const engine = new Engine("/path/to/repo");
 *   const callers = await engine.findCallers("MyClass.myMethod");
 *   console.log(callers.result, callers.verification, callers.finalStatus);
 *   engine.close();
 */

// ------------------------------------------------------------------ Engine
export { Engine } from "./engine/engine.js";
export type { EngineOptions } from "./engine/engine.js";

// ----------------------------------------------------------------- Planner
export { Planner } from "./planning/planner.js";
export type { PlanOutcome, PlannerMode, PlannerOptions } from "./planning/planner.js";
export { PlannerMemory } from "./planning/memory.js";
export { QueryCache, ENGINE_FINGERPRINT } from "./planning/query-cache.js";
export type { CacheEntry, CacheStats } from "./planning/query-cache.js";

// -------------------------------------------------------------- Knowledge
export { KnowledgeStore } from "./knowledge/store.js";

// ------------------------------------------------------------------ Tasks
export type { TaskDefinition, ResidualRisk, RiskFactor, Uncertainty } from "./tasks/task.js";
export type { FindCallersResult, CallerFinding, CallerClass } from "./tasks/find-callers.js";
export type { FindCalleesResult } from "./tasks/find-callees.js";
export type {
  FindReferencesResult,
  ReferenceFinding,
  ImpactOfChangeResult,
  ImpactEdge,
  WhichTestsResult,
  TestFinding,
  WhyChangedResult,
  ChangeRecord,
  ModuleDependentsResult,
  AnyTaskResult,
} from "./tasks/queries.js";

// ------------------------------------------------------------ Verification
export {
  classifyFinalStatus,
  verifyFindCallers,
  verifyFindCallees,
  verifyFindReferences,
  verifyImpactOfChange,
  verifyModuleDependents,
  verifyWhichTestsExercise,
} from "./verification/verify.js";
export type { VerificationRecord, VerifiedPlanOutcome, VerifyOptions, FinalStatus } from "./verification/verify.js";
export type { ChallengeOutcome, VerificationEvidence } from "./verification/challenge.js";
export type { EvidenceComparison } from "./verification/compare.js";

// ------------------------------------------------------------------ Model
export type { Entity, Evidence, Resolution, SourceLocation, UnknownRegion } from "./canonical/model.js";
export { formatLocation } from "./canonical/model.js";

// ------------------------------------------------------------- Crystallization & overview
export { crystallizationLevel } from "./crystallization/levels.js";
export type { CrystallizationLevel, CrystallizationReport } from "./crystallization/levels.js";
export { repoOverview } from "./tasks/repo-overview.js";
export type { RepoOverviewResult, ModuleSummary } from "./tasks/repo-overview.js";

// ------------------------------------------------------------------- SCIP
export { exportScip } from "./scip/export.js";
