import path from "node:path";
import ts from "typescript";
import { SourceLocation, SourceType, Soundness } from "../canonical/model.js";
import { listSourceFiles, rel } from "../acquisition/program.js";
import { languageServiceOracle } from "../groundtruth/oracles.js";

/**
 * Independent verification analyses.
 *
 * INDEPENDENCE BOUNDARY (read this before adding another challenge):
 *
 * The primary FindCallers/FindCallees path (`acquisition/calls.ts` via
 * `ResolveCalls`) resolves every call expression itself: it walks the AST
 * once, and for each call asks `ts.TypeChecker#getSymbolAtLocation` /
 * `#getTypeAtLocation` directly, threading receiver-type reasoning and
 * override expansion through code owned by this repository
 * (`tasks/override-graph.ts`).
 *
 * The challenge functions below instead call `ts.LanguageService` entry
 * points that TypeScript itself implements end-to-end:
 * `findReferences` (for FindCallers, via the existing independent oracle in
 * `groundtruth/oracles.ts` — reused here rather than duplicated) and
 * `getDefinitionAtPosition` (for FindCallees, new in this file). Both are
 * black-box APIs whose internal symbol/reference resolution is not code this
 * repository wrote or controls — they are a different algorithm inside the
 * compiler, not a second call to the same resolution function. That is the
 * independence this module relies on: independent *implementation path*,
 * not independent *toolchain* (both ultimately sit on the TypeScript
 * compiler; there is no second, unrelated static analyzer in this
 * environment to call instead — see the report for why that's an accepted
 * boundary rather than a hidden assumption).
 *
 * Both challenge functions are read-only: neither writes to the
 * `KnowledgeStore`, so a challenge can never contaminate the evidence the
 * primary analysis produced, and re-running a query never depends on
 * whether a challenge happened to run before it.
 */

export const CHALLENGE_ANALYSIS_VERSION = "1";

export interface VerificationEvidence {
  claim: string;
  source: string;
  sourceType: SourceType;
  location: SourceLocation | null;
  revision: string;
  analysisName: string;
  analysisVersion: string;
  /** what the challenge consumed, described at the level that can honestly be stated */
  inputs: string[];
  /** documented, known limitations of this specific mechanism — not invented */
  assumptions: string[];
  coverage: "full-repository" | "unknown";
  /** evidence this challenge depended on; empty means computed independently of the primary path */
  dependencies: string[];
  soundness: Soundness;
  observedAt: string;
}

export interface ChallengeOutcome {
  method: string;
  /** file:line sites the challenge independently established */
  sites: string[];
  evidence: VerificationEvidence[];
  costMs: number;
  /** null when the challenge mechanism could not run at all (e.g. no TS files) */
  unavailableReason: string | null;
}

function buildLanguageServiceHost(root: string, files: string[]): ts.LanguageServiceHost {
  return {
    getScriptFileNames: () => files,
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => {
      const text = ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      strict: true,
    }),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
}

// ------------------------------------------------------------ FindCallers

/**
 * Challenge FindCallers using `ts.LanguageService#findReferences` — the same
 * independent oracle already used for test-time ground truth in
 * `groundtruth/oracles.ts`, reused here at query time. Known imprecision
 * (documented, not silently hidden): it unifies interface/abstract members
 * with every implementation, including sibling implementations the queried
 * declaration cannot itself reach, so it is expected to be over-inclusive
 * relative to the primary receiver-type-aware resolution.
 */
export function challengeFindCallers(root: string, symbol: string, revision: string): ChallengeOutcome {
  const start = process.hrtime.bigint();
  let sites: string[] = [];
  let unavailableReason: string | null = null;
  try {
    const oracle = languageServiceOracle(root, symbol);
    sites = oracle.groundTruth;
  } catch (err) {
    unavailableReason = err instanceof Error ? err.message : String(err);
  }
  const costMs = Number(process.hrtime.bigint() - start) / 1e6;

  const evidence: VerificationEvidence[] = sites.map((site) => ({
    claim: `${symbol} may be called at ${site} (independent language-service reference search)`,
    source: "ts.LanguageService#findReferences",
    sourceType: "typescript-language-service",
    location: parseSite(site),
    revision,
    analysisName: "ChallengeFindCallers",
    analysisVersion: CHALLENGE_ANALYSIS_VERSION,
    inputs: ["repository source files", `symbol query: ${symbol}`],
    assumptions: [
      "unifies an interface/abstract member with every implementation, including siblings the queried declaration cannot itself reach",
      "does not perform the primary path's receiver-type narrowing",
    ],
    coverage: "full-repository",
    dependencies: [],
    soundness: "SOUND_UNDER_ASSUMPTIONS",
    observedAt: new Date().toISOString(),
  }));

  return {
    method: "language-service-refs",
    sites,
    evidence,
    costMs,
    unavailableReason,
  };
}

// ------------------------------------------------------------ FindCallees

function ownerName(node: ts.Node): string | null {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if ((ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p)) && p.name) return p.name.text;
    p = p.parent;
  }
  return null;
}

/**
 * Challenge FindCallees using `ts.LanguageService#getDefinitionAtPosition` —
 * go-to-definition is an independent code path from the checker-driven
 * symbol resolution `acquisition/calls.ts` uses: it resolves a position
 * through the language service's own definition-info machinery rather than
 * `checker.getSymbolAtLocation`. For every call expression found inside the
 * queried declaration's body (found by an independent AST walk in this
 * file, not by reusing `acquisition/calls.ts`), this asks the language
 * service what the callee identifier's definition is, and reports the name
 * of whatever declaration(s) it points at.
 */
export function challengeFindCallees(root: string, symbol: string, revision: string): ChallengeOutcome {
  const start = process.hrtime.bigint();
  const found: { calleeName: string; callSite: string }[] = [];
  let unavailableReason: string | null = null;

  try {
    const files = listSourceFiles(root).map((f) => path.resolve(f));
    const service = ts.createLanguageService(buildLanguageServiceHost(root, files), ts.createDocumentRegistry());
    const program = service.getProgram();
    if (!program) throw new Error("language service produced no program");

    const name = symbol.includes(".") ? symbol.slice(symbol.lastIndexOf(".") + 1) : symbol;
    const container = symbol.includes(".") ? symbol.slice(0, symbol.lastIndexOf(".")) : null;

    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || !path.resolve(sf.fileName).startsWith(path.resolve(root))) continue;
      const visitDecl = (node: ts.Node): void => {
        const isCallable =
          ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node);
        if (isCallable && node.name && ts.isIdentifier(node.name) && node.name.text === name) {
          if (container === null || ownerName(node) === container) {
            walkBodyForCalls(node, sf, service, root, found);
          }
        }
        ts.forEachChild(node, visitDecl);
      };
      ts.forEachChild(sf, visitDecl);
    }
  } catch (err) {
    unavailableReason = err instanceof Error ? err.message : String(err);
  }
  const costMs = Number(process.hrtime.bigint() - start) / 1e6;

  const sites = [...new Set(found.map((f) => f.callSite))].sort();
  const evidence: VerificationEvidence[] = found.map((f) => ({
    claim: `${symbol} calls something resolving to '${f.calleeName}' at ${f.callSite} (independent go-to-definition)`,
    source: "ts.LanguageService#getDefinitionAtPosition",
    sourceType: "typescript-language-service",
    location: parseSite(f.callSite),
    revision,
    analysisName: "ChallengeFindCallees",
    analysisVersion: CHALLENGE_ANALYSIS_VERSION,
    inputs: ["repository source files", `symbol query: ${symbol}`],
    assumptions: [
      "reports the definition name only; does not perform the primary path's virtual-dispatch expansion",
      "a call whose callee has no single definition (dynamic/computed access) is not reported, not treated as absent",
    ],
    coverage: "full-repository",
    dependencies: [],
    soundness: "SOUND_UNDER_ASSUMPTIONS",
    observedAt: new Date().toISOString(),
  }));

  return {
    method: "language-service-goto-definition",
    sites,
    evidence,
    costMs,
    unavailableReason,
  };
}

function walkBodyForCalls(
  decl: ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration,
  sf: ts.SourceFile,
  service: ts.LanguageService,
  root: string,
  out: { calleeName: string; callSite: string }[],
): void {
  const body = decl.body;
  if (!body) return;
  const visit = (node: ts.Node): void => {
    // `new X()` is a callee too (constructor invocation): the primary path
    // reports it as a call to the class name, so the challenge must look at
    // NewExpression nodes as well as CallExpression, or every constructor
    // call would spuriously show up as "only in primary" — a coverage gap
    // in the challenge, not a real disagreement.
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let callee: ts.Expression = node.expression;
      while (ts.isNonNullExpression(callee) || ts.isParenthesizedExpression(callee)) callee = callee.expression;
      const idNode = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : null;
      if (idNode) {
        const defs = service.getDefinitionAtPosition(sf.fileName, idNode.getStart(sf));
        for (const def of defs ?? []) {
          const site = `${rel(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
          out.push({ calleeName: def.name, callSite: site });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

// ---------------------------------------------------------- FindReferences

/**
 * Challenge FindReferences using `ts.LanguageService#findReferences`,
 * reporting *every* reference (reads, writes, type positions — not just
 * call sites, unlike `challengeFindCallers`). The primary path
 * (`tasks/queries.ts` findReferencesTask, via `acquisition`'s REFERENCES
 * relation) is built during `BuildReferences` from the checker's own
 * symbol-at-location walk; this instead asks the language service's
 * findReferences implementation directly, the same black-box entry point
 * `challengeFindCallers` uses but without filtering to call sites.
 */
export function challengeFindReferences(root: string, symbol: string, revision: string): ChallengeOutcome {
  const start = process.hrtime.bigint();
  const sites = new Set<string>();
  let unavailableReason: string | null = null;
  try {
    const files = listSourceFiles(root).map((f) => path.resolve(f));
    const service = ts.createLanguageService(buildLanguageServiceHost(root, files), ts.createDocumentRegistry());
    const program = service.getProgram();
    if (!program) throw new Error("language service produced no program");
    const name = symbol.includes(".") ? symbol.slice(symbol.lastIndexOf(".") + 1) : symbol;
    const container = symbol.includes(".") ? symbol.slice(0, symbol.lastIndexOf(".")) : null;

    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || !path.resolve(sf.fileName).startsWith(path.resolve(root))) continue;
      const visit = (node: ts.Node): void => {
        const isNamed =
          (ts.isFunctionDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isGetAccessorDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isVariableDeclaration(node)) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.name.text === name;
        if (isNamed && (container === null || ownerName(node) === container)) {
          const nameNode = (node as { name: ts.Identifier }).name;
          for (const group of service.findReferences(sf.fileName, nameNode.getStart(sf)) ?? []) {
            for (const entry of group.references) {
              if (entry.isDefinition) continue;
              const target = program.getSourceFile(entry.fileName);
              if (!target) continue;
              const pos = target.getLineAndCharacterOfPosition(entry.textSpan.start);
              sites.add(`${rel(root, target.fileName)}:${pos.line + 1}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(sf, visit);
    }
  } catch (err) {
    unavailableReason = err instanceof Error ? err.message : String(err);
  }
  const costMs = Number(process.hrtime.bigint() - start) / 1e6;
  const sorted = [...sites].sort();

  const evidence: VerificationEvidence[] = sorted.map((site) => ({
    claim: `${symbol} is referenced at ${site} (independent language-service reference search, unfiltered)`,
    source: "ts.LanguageService#findReferences",
    sourceType: "typescript-language-service",
    location: parseSite(site),
    revision,
    analysisName: "ChallengeFindReferences",
    analysisVersion: CHALLENGE_ANALYSIS_VERSION,
    inputs: ["repository source files", `symbol query: ${symbol}`],
    assumptions: [
      "unifies an interface/abstract member with every implementation, including siblings the queried declaration cannot itself reach",
      "reports every reference kind (read, write, type position); does not classify by kind the way the primary path's REFERENCES relation can",
    ],
    coverage: "full-repository",
    dependencies: [],
    soundness: "SOUND_UNDER_ASSUMPTIONS",
    observedAt: new Date().toISOString(),
  }));

  return { method: "language-service-refs-unfiltered", sites: sorted, evidence, costMs, unavailableReason };
}

// -------------------------------------------------------- ModuleDependents

/**
 * Challenge ModuleDependents with a fresh AST + module-resolution walk that
 * never touches the `KnowledgeStore`. The primary path
 * (`tasks/queries.ts` moduleDependentsTask) reads IMPORTS relations that
 * `ParseSource`/`acquisition` recorded while building the knowledge graph;
 * this instead re-parses every file's import/export/require specifiers
 * directly and re-resolves each one with `ts.resolveModuleName` — a second,
 * independent pass over the same source text rather than a read of
 * previously-recorded facts.
 */
export function challengeModuleDependents(root: string, moduleQuery: string, revision: string): ChallengeOutcome {
  const start = process.hrtime.bigint();
  const normalized = moduleQuery.replace(/^\.\//, "");
  const sites = new Set<string>();
  let unavailableReason: string | null = null;
  try {
    const files = listSourceFiles(root).map((f) => path.resolve(f));
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
    };
    const matchesTarget = (resolved: string): boolean => {
      const r = rel(root, resolved).replace(/\.[cm]?[jt]sx?$/, "");
      return r === normalized.replace(/\.[cm]?[jt]sx?$/, "") || r.endsWith(`/${normalized.replace(/\.[cm]?[jt]sx?$/, "")}`);
    };
    const specifiers: { file: string; text: string; line: number }[] = [];
    for (const f of files) {
      const abs = path.resolve(f);
      const text = ts.sys.readFile(abs);
      if (text === undefined) continue;
      const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2022, true);
      const visit = (node: ts.Node): void => {
        let spec: ts.Expression | undefined;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          spec = node.moduleSpecifier;
        } else if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require" &&
          node.arguments.length === 1
        ) {
          spec = node.arguments[0];
        }
        if (spec && ts.isStringLiteral(spec)) {
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          specifiers.push({ file: abs, text: spec.text, line: pos.line + 1 });
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(sf, visit);
    }
    for (const { file, text, line } of specifiers) {
      const resolved = ts.resolveModuleName(text, file, compilerOptions, ts.sys);
      const resolvedFile = resolved.resolvedModule?.resolvedFileName;
      if (resolvedFile && matchesTarget(resolvedFile)) {
        sites.add(`${rel(root, file)}:${line}`);
      }
    }
  } catch (err) {
    unavailableReason = err instanceof Error ? err.message : String(err);
  }
  const costMs = Number(process.hrtime.bigint() - start) / 1e6;
  const sorted = [...sites].sort();

  const evidence: VerificationEvidence[] = sorted.map((site) => ({
    claim: `${site} imports '${moduleQuery}' (independent re-parse + ts.resolveModuleName)`,
    source: "ts.resolveModuleName",
    sourceType: "typescript-language-service",
    location: parseSite(site),
    revision,
    analysisName: "ChallengeModuleDependents",
    analysisVersion: CHALLENGE_ANALYSIS_VERSION,
    inputs: ["repository source files", `module query: ${moduleQuery}`],
    assumptions: [
      "matches by resolved-file path suffix, same convention the primary path uses for module identity",
      "does not distinguish type-only imports from value imports",
    ],
    coverage: "full-repository",
    dependencies: [],
    soundness: "SOUND_UNDER_ASSUMPTIONS",
    observedAt: new Date().toISOString(),
  }));

  return { method: "resolve-module-name", sites: sorted, evidence, costMs, unavailableReason };
}

// ----------------------------------------------------- WhichTestsExercise

/**
 * Challenge WhichTestsExercise's *statically* evidenced findings only, by
 * checking — via `ts.LanguageService#findReferences` — which test files
 * reference the symbol directly. This is intentionally shallower than the
 * primary path (which can trace multi-hop static call paths and coverage
 * data): it corroborates "this test file touches the symbol at all," not
 * "this test file exercises it through N intermediate calls." Runtime
 * findings (coverage/stack-trace evidence) are already independent,
 * observational evidence and are not re-challenged here — see
 * docs/verification-layer.md.
 */
export function challengeWhichTestsExercise(root: string, symbol: string, revision: string): ChallengeOutcome {
  const start = process.hrtime.bigint();
  const sites = new Set<string>();
  let unavailableReason: string | null = null;
  try {
    const files = listSourceFiles(root).map((f) => path.resolve(f));
    const service = ts.createLanguageService(buildLanguageServiceHost(root, files), ts.createDocumentRegistry());
    const program = service.getProgram();
    if (!program) throw new Error("language service produced no program");
    const name = symbol.includes(".") ? symbol.slice(symbol.lastIndexOf(".") + 1) : symbol;
    const container = symbol.includes(".") ? symbol.slice(0, symbol.lastIndexOf(".")) : null;

    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || !path.resolve(sf.fileName).startsWith(path.resolve(root))) continue;
      const visit = (node: ts.Node): void => {
        const isNamed =
          (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.name.text === name;
        if (isNamed && (container === null || ownerName(node) === container)) {
          const nameNode = (node as { name: ts.Identifier }).name;
          for (const group of service.findReferences(sf.fileName, nameNode.getStart(sf)) ?? []) {
            for (const entry of group.references) {
              if (entry.isDefinition) continue;
              const target = program.getSourceFile(entry.fileName);
              if (!target) continue;
              const relPath = rel(root, target.fileName);
              if (!isTestFilePath(relPath)) continue;
              const pos = target.getLineAndCharacterOfPosition(entry.textSpan.start);
              sites.add(`${relPath}:${pos.line + 1}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(sf, visit);
    }
  } catch (err) {
    unavailableReason = err instanceof Error ? err.message : String(err);
  }
  const costMs = Number(process.hrtime.bigint() - start) / 1e6;
  const sorted = [...sites].sort();

  const evidence: VerificationEvidence[] = sorted.map((site) => ({
    claim: `test file ${site.split(":")[0]} references ${symbol} directly at ${site} (independent language-service reference search, test files only)`,
    source: "ts.LanguageService#findReferences",
    sourceType: "typescript-language-service",
    location: parseSite(site),
    revision,
    analysisName: "ChallengeWhichTestsExercise",
    analysisVersion: CHALLENGE_ANALYSIS_VERSION,
    inputs: ["repository source files", `symbol query: ${symbol}`],
    assumptions: [
      "only corroborates direct static references from a test file; does not walk multi-hop static call paths the way the primary path can",
      "does not corroborate runtime/coverage-based findings, which are already independent observational evidence",
    ],
    coverage: "full-repository",
    dependencies: [],
    soundness: "SOUND_UNDER_ASSUMPTIONS",
    observedAt: new Date().toISOString(),
  }));

  return { method: "language-service-refs-test-files", sites: sorted, evidence, costMs, unavailableReason };
}

function isTestFilePath(file: string): boolean {
  return /(^|\/)tests?\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function parseSite(site: string): SourceLocation | null {
  const idx = site.lastIndexOf(":");
  if (idx === -1) return null;
  const file = site.slice(0, idx);
  const line = Number(site.slice(idx + 1));
  if (!Number.isFinite(line)) return null;
  return { file, line, column: 0 };
}
