/**
 * Canonical model: entities, relationships and evidence.
 *
 * Two hard rules encoded here:
 *  1. Every relationship in the model is derived from at least one Evidence record.
 *  2. Contradictions are represented, never overwritten (see EvidenceStatus.CONFLICTING).
 */

export type EntityKind =
  | "Repository"
  | "File"
  | "Module"
  | "Symbol"
  | "Function"
  | "Method"
  | "Class"
  | "Interface"
  | "Type"
  | "Reference"
  | "Call"
  | "Dependency"
  | "Commit"
  | "Test"
  | "RuntimeEvent"
  | "Coverage"
  | "Documentation"
  | "PullRequest"
  | "Issue";

export type RelationKind =
  | "IMPORTS"
  | "EXPORTS"
  | "DECLARES"
  | "REFERENCES"
  | "CALLS"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "DEPENDS_ON"
  | "TESTS"
  | "CHANGED_BY"
  | "DOCUMENTS"
  | "EXECUTED_AS"
  | "COVERS"
  | "COUPLED_WITH"
  | "MENTIONS"
  | "AUTHORED_BY";

/** Evidence status. Never collapse UNKNOWN/CONFLICTING into a number. */
export enum EvidenceStatus {
  RESOLVED = "RESOLVED",
  PARTIAL = "PARTIAL",
  UNRESOLVED = "UNRESOLVED",
  CONFLICTING = "CONFLICTING",
  UNKNOWN = "UNKNOWN",
  /** Evidence that was once RESOLVED but whose revision is no longer current. */
  STALE = "STALE",
}

/**
 * What kind of claim an analysis is entitled to make. Confidence and
 * correctness are not the same thing: a HEURISTIC analysis that runs
 * perfectly still only produces heuristic evidence.
 *
 *   SOUND                 - always correct when it produces a result at all
 *   SOUND_UNDER_ASSUMPTIONS - correct given stated assumptions (e.g. no
 *                             reflection, no dynamic `eval`, valid tsconfig)
 *   HEURISTIC             - a rule of thumb; can be systematically wrong
 *   OBSERVATIONAL         - reports what was observed to happen, not what
 *                           can happen; silence is not absence
 *   SPECULATIVE           - an interpretation or hypothesis, not a fact
 */
export type Soundness = "SOUND" | "SOUND_UNDER_ASSUMPTIONS" | "HEURISTIC" | "OBSERVATIONAL" | "SPECULATIVE";

/** How a call target was resolved. Ambiguity is never silently promoted. */
export enum Resolution {
  EXACT = "EXACT",
  PARTIAL = "PARTIAL",
  AMBIGUOUS = "AMBIGUOUS",
  UNRESOLVED = "UNRESOLVED",
}

/** Sources of evidence that this engine can actually read. */
export type SourceType =
  | "typescript-compiler"
  | "typescript-language-service"
  | "filesystem"
  | "git"
  | "coverage"
  | "runtime-trace"
  | "test-runner"
  | "ci"
  | "documentation"
  | "configuration"
  | "forge"
  | "stack-trace"
  | "python-ast";

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  location?: SourceLocation;
  /** Only facts that a reader can verify at `location`. No scores. */
  attributes: Record<string, string | number | boolean | null>;
}

export interface Relation {
  id: string;
  kind: RelationKind;
  from: string;
  to: string | null;
  /** null `to` means the target could not be resolved; keep the edge, mark it. */
  resolution: Resolution;
  location?: SourceLocation;
  attributes: Record<string, string | number | boolean | null>;
}

export interface Evidence {
  id: string;
  /** Human-readable claim, e.g. "authenticate() calls verifyToken()". */
  fact: string;
  /** Concrete producer, e.g. "ts.TypeChecker#getSymbolAtLocation". */
  source: string;
  sourceType: SourceType;
  location: SourceLocation | null;
  /** Repository revision (git sha) or content hash when git is unavailable. */
  revision: string;
  /** How the fact was derived, e.g. "direct-call-expression". */
  derivation: string;
  status: EvidenceStatus;
  /** Analysis name that produced this evidence. */
  producedBy: string;
  /** Entities/relations this evidence supports. */
  supports: string[];
  observedAt: string;
}

/** A region of the source world the engine knows it has not established. */
export interface UnknownRegion {
  kind:
    | "unparsed-file"
    | "missing-file"
    | "unsupported-syntax"
    | "unresolved-call"
    | "ambiguous-call"
    | "dynamic-dispatch"
    | "reflection"
    | "generated-code"
    | "stale-index"
    | "no-runtime-data"
    | "no-coverage-data"
    | "no-git-data"
    | "no-test-data"
    | "no-forge-data"
    | "no-documentation"
    | "documentation-drift";
  location: SourceLocation | null;
  detail: string;
}

export function entityId(kind: EntityKind, key: string): string {
  return `${kind}:${key}`;
}

export function locationKey(loc: SourceLocation): string {
  return `${loc.file}:${loc.line}:${loc.column}`;
}

export function formatLocation(loc: SourceLocation): string {
  return `${loc.file}:${loc.line}:${loc.column}`;
}
