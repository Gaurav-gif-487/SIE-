/**
 * Independent ground-truth sources for FindCallers.
 *
 * Three *separate* methods, so that no measurement depends on the engine's own
 * output:
 *
 *   1. manual-label            - hand-written labels in tests/groundtruth/*.labels.json
 *   2. type-directed-checker   - a self-contained TypeScript checker walk implemented
 *                                here, in this file only, with receiver-type filtering
 *   3. language-service-refs   - ts.LanguageService#findReferences, call sites only
 *                                (over-inclusive: it unifies interface members with
 *                                every implementation, including siblings)
 *
 * Nothing in this file imports the engine's task, planner, knowledge or call
 * acquisition code. Only file discovery is shared (`listSourceFiles`), which is
 * a directory walk, not a semantic decision.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listSourceFiles, rel } from "../acquisition/program.js";

export type SiteCategory = "direct" | "virtual" | "indirect" | "dynamic";

export interface GroundTruth {
  repository: string;
  task: string;
  symbol: string;
  method: "manual-label" | "type-directed-checker" | "language-service-refs";
  /** file:line of every may-caller site */
  groundTruth: string[];
  /** sites the method deliberately excludes from strict scoring */
  excluded?: { site: string; category: SiteCategory }[];
}

// -------------------------------------------------------------- manual labels
interface LabelFile {
  repository: string;
  method: string;
  targets: {
    task: string;
    symbol: string;
    declaration: string;
    groundTruth: { site: string; category: SiteCategory }[];
  }[];
}

export function loadLabelFile(file: string): LabelFile {
  return JSON.parse(fs.readFileSync(file, "utf8")) as LabelFile;
}

/** Strict manual ground truth: direct + virtual sites. */
export function manualOracle(labels: LabelFile, symbol: string): GroundTruth | null {
  const entry = labels.targets.find((t) => t.symbol === symbol);
  if (!entry) return null;
  return {
    repository: labels.repository,
    task: entry.task,
    symbol,
    method: "manual-label",
    groundTruth: entry.groundTruth
      .filter((g) => g.category === "direct" || g.category === "virtual")
      .map((g) => g.site)
      .sort(),
    excluded: entry.groundTruth.filter((g) => g.category === "indirect" || g.category === "dynamic"),
  };
}

// ------------------------------------------------------- type-directed oracle
function createProgram(root: string): ts.Program {
  const files = listSourceFiles(root).map((f) => path.resolve(f));
  return ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    strict: true,
    noEmit: true,
  });
}

function ownerClassName(node: ts.Node): string | null {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if ((ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p)) && p.name) return p.name.text;
    p = p.parent;
  }
  return null;
}

/** Member declarations with `member` in every ancestor of `decl`'s container. */
function ancestorMemberDecls(checker: ts.TypeChecker, decl: ts.Node, member: string): Set<ts.Node> {
  const out = new Set<ts.Node>();
  const start = (() => {
    let p: ts.Node | undefined = decl.parent;
    while (p) {
      if (ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p)) return p;
      p = p.parent;
    }
    return undefined;
  })();
  if (!start) return out;
  const queue: (ts.ClassDeclaration | ts.InterfaceDeclaration)[] = [start];
  const seen = new Set<ts.Node>([start]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const clause of current.heritageClauses ?? []) {
      for (const expr of clause.types) {
        let symbol = checker.getSymbolAtLocation(expr.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        for (const d of symbol?.declarations ?? []) {
          if (!ts.isClassDeclaration(d) && !ts.isInterfaceDeclaration(d)) continue;
          if (seen.has(d)) continue;
          seen.add(d);
          queue.push(d);
          for (const m of d.members) {
            if (m.name && ts.isIdentifier(m.name) && m.name.text === member) out.add(m);
          }
        }
      }
    }
  }
  return out;
}

function targetDeclarations(
  program: ts.Program,
  root: string,
  symbol: string,
): { decl: ts.Node; name: string; container: string | null }[] {
  const name = symbol.includes(".") ? symbol.slice(symbol.lastIndexOf(".") + 1) : symbol;
  const container = symbol.includes(".") ? symbol.slice(0, symbol.lastIndexOf(".")) : null;
  const out: { decl: ts.Node; name: string; container: string | null }[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !path.resolve(sf.fileName).startsWith(path.resolve(root))) continue;
    const visit = (node: ts.Node): void => {
      const isCallable =
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isGetAccessorDeclaration(node);
      if (isCallable && node.name && ts.isIdentifier(node.name) && node.name.text === name) {
        const owner = ownerClassName(node);
        if (container === null || owner === container) out.push({ decl: node, name, container: owner });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return out;
}

/**
 * Type-directed oracle: for every call expression, decide whether the target's
 * body may execute, using the receiver *type* only.
 */
export function typeDirectedOracle(root: string, symbol: string): GroundTruth {
  const program = createProgram(root);
  const checker = program.getTypeChecker();
  const targets = targetDeclarations(program, root, symbol);
  const targetSet = new Set(targets.map((t) => t.decl));
  const supertypeDecls = new Set<ts.Node>();
  for (const t of targets) for (const d of ancestorMemberDecls(checker, t.decl, t.name)) supertypeDecls.add(d);

  const sites = new Set<string>();
  const excluded: { site: string; category: SiteCategory }[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !path.resolve(sf.fileName).startsWith(path.resolve(root))) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const site = `${rel(root, sf.fileName)}:${
          sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        }`;
        let callee: ts.Expression = node.expression;
        while (ts.isNonNullExpression(callee) || ts.isParenthesizedExpression(callee)) callee = callee.expression;

        if (ts.isElementAccessExpression(callee)) {
          excluded.push({ site, category: "dynamic" });
        } else if (ts.isPropertyAccessExpression(callee)) {
          const member = callee.name.text;
          const recvType = checker.getTypeAtLocation(callee.expression);
          const constituents = recvType.isUnion() ? recvType.types : [recvType];
          let hit = false;
          for (const constituent of constituents) {
            const base = constituent.isIntersection() ? constituent.types : [constituent];
            for (const b of base) {
              const prop = b.getProperty(member);
              for (const d of prop?.declarations ?? []) {
                if (targetSet.has(d) || supertypeDecls.has(d)) hit = true;
              }
              // generic type parameter: use its constraint
              const constraint = b.flags & ts.TypeFlags.TypeParameter ? b.getConstraint() : undefined;
              const cprop = constraint?.getProperty(member);
              for (const d of cprop?.declarations ?? []) {
                if (targetSet.has(d) || supertypeDecls.has(d)) hit = true;
              }
            }
          }
          if (hit) sites.add(site);
        } else {
          let s = checker.getSymbolAtLocation(callee);
          if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
          const decls = s?.declarations ?? [];
          if (decls.some((d) => targetSet.has(d))) sites.add(site);
          else if (decls.some((d) => ts.isParameter(d) || ts.isVariableDeclaration(d)))
            excluded.push({ site, category: "indirect" });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return {
    repository: root,
    task: "FindCallers",
    symbol,
    method: "type-directed-checker",
    groundTruth: [...sites].sort(),
    excluded,
  };
}

// --------------------------------------------------- language-service oracle
function findIdentifierAt(sf: ts.SourceFile, pos: number): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (n: ts.Node): void => {
    if (n.getStart(sf) <= pos && pos < n.getEnd()) {
      if (ts.isIdentifier(n)) found = n;
      ts.forEachChild(n, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return found;
}

export function languageServiceOracle(root: string, symbol: string): GroundTruth {
  const files = listSourceFiles(root).map((f) => path.resolve(f));
  const host: ts.LanguageServiceHost = {
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
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = service.getProgram()!;
  const name = symbol.includes(".") ? symbol.slice(symbol.lastIndexOf(".") + 1) : symbol;
  const container = symbol.includes(".") ? symbol.slice(0, symbol.lastIndexOf(".")) : null;
  const sites = new Set<string>();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !path.resolve(sf.fileName).startsWith(path.resolve(root))) continue;
    const visit = (node: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        (container === null || ownerClassName(node) === container)
      ) {
        for (const group of service.findReferences(sf.fileName, node.name.getStart(sf)) ?? []) {
          for (const entry of group.references) {
            if (entry.isDefinition) continue;
            const target = program.getSourceFile(entry.fileName);
            if (!target) continue;
            const id = findIdentifierAt(target, entry.textSpan.start);
            if (!id || !id.parent) continue;
            const isCall =
              (ts.isCallExpression(id.parent) && id.parent.expression === id) ||
              (ts.isPropertyAccessExpression(id.parent) &&
                ts.isCallExpression(id.parent.parent) &&
                id.parent.parent.expression === id.parent);
            if (!isCall) continue;
            const call = ts.isCallExpression(id.parent) ? id.parent : id.parent.parent;
            const pos = target.getLineAndCharacterOfPosition(call.getStart(target));
            sites.add(`${rel(root, target.fileName)}:${pos.line + 1}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return {
    repository: root,
    task: "FindCallers",
    symbol,
    method: "language-service-refs",
    groundTruth: [...sites].sort(),
  };
}

/** Disagreement between two ground-truth methods. Reported, never silently resolved. */
export function agreement(a: GroundTruth, b: GroundTruth) {
  const onlyA = a.groundTruth.filter((s) => !b.groundTruth.includes(s));
  const onlyB = b.groundTruth.filter((s) => !a.groundTruth.includes(s));
  return {
    symbol: a.symbol,
    methodA: a.method,
    methodB: b.method,
    agreed: a.groundTruth.filter((s) => b.groundTruth.includes(s)).length,
    onlyInA: onlyA,
    onlyInB: onlyB,
    identical: onlyA.length === 0 && onlyB.length === 0,
  };
}
