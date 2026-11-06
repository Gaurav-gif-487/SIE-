import ts from "typescript";
import path from "node:path";
import { rel } from "../acquisition/program.js";
import { createProgram } from "./oracles-ext.js";

/**
 * ORACLE CHANGE — Phase 1.3. Additive, never imported by the engine.
 *
 * `callImpactOracle` (oracles-ext.ts) keys its fixed-point closure on textual
 * declaration *names*. On a repository with three unrelated functions all
 * called `foo`, that necessarily merges three disjoint impact closures into
 * one, and there is no query by which the caller can ask about only one of
 * them. The benchmark's task selector avoids this today by filtering to
 * uniquely-named symbols (dataset.ts `counts.get(name) === 1`), which is why
 * the defect has not shown up in scores — but it also means the oracle cannot
 * be pointed at a colliding symbol at all, and any future task set that drops
 * the uniqueness filter would silently score against a merged closure.
 *
 * This oracle keys on *declaration identity* instead: the target is a
 * (name, declaring file) pair resolved to concrete `ts` declaration nodes, and
 * every call site is resolved through the checker (with alias/re-export chains
 * followed) to the declaration node it actually reaches. Names are never
 * compared. It is deliberately a separate file so that oracle changes stay
 * separable from engine changes.
 *
 * Semantics are CALL semantics, matching `callImpactOracle` and the Phase 1.1
 * decision: `X()` and `new X()` propagate impact, a bare value reference to X
 * does not. The declaring file of the target is always impacted.
 */

type Unit = { key: string; file: string };

/** The declaration whose behaviour changes if `node` changes: nearest enclosing function-like or class, else the module. */
function enclosingUnit(node: ts.Node, sf: ts.SourceFile, root: string): Unit {
  let n: ts.Node | undefined = node;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isClassDeclaration(n)
    ) {
      const pos = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      return { key: `${rel(root, sf.fileName)}:${pos.line + 1}:${pos.character + 1}`, file: rel(root, sf.fileName) };
    }
    n = n.parent;
  }
  // module top level: a call there runs at import time
  return { key: `${rel(root, sf.fileName)}:module`, file: rel(root, sf.fileName) };
}

function unitOfDeclaration(decl: ts.Node, root: string): Unit {
  const sf = decl.getSourceFile();
  const pos = sf.getLineAndCharacterOfPosition(decl.getStart(sf));
  return { key: `${rel(root, sf.fileName)}:${pos.line + 1}:${pos.character + 1}`, file: rel(root, sf.fileName) };
}

function aliasResolve(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  let s = sym;
  while (s && s.flags & ts.SymbolFlags.Alias) {
    try {
      s = checker.getAliasedSymbol(s);
    } catch {
      break;
    }
  }
  return s;
}

/** Declaration nodes for `name` declared in `declFile` (repo-relative). */
function targetDeclarations(program: ts.Program, root: string, name: string, declFile: string): ts.Node[] {
  const want = declFile.replace(/\\/g, "/");
  const out: ts.Node[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!path.resolve(sf.fileName).startsWith(path.resolve(root))) continue;
    if (rel(root, sf.fileName).replace(/\\/g, "/") !== want) continue;
    const visit = (node: ts.Node) => {
      const named =
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isMethodSignature(node) ||
          ts.isClassDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node)) &&
        node.name &&
        node.name.getText(sf) === name;
      if (named) out.push(node);
      if (ts.isConstructorDeclaration(node)) {
        const cls = node.parent;
        if (ts.isClassDeclaration(cls) && cls.name?.getText(sf) === name) out.push(node);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return out;
}

export function callImpactOracleAt(root: string, name: string, declFile: string, opts: { fresh?: boolean } = {}): string[] {
  const program = createProgram(root, opts);
  const checker = program.getTypeChecker();

  const targets = targetDeclarations(program, root, name, declFile);
  if (targets.length === 0) throw new Error(`no declaration of '${name}' in ${declFile}`);

  // Edge set: callerUnit -> calleeUnit, built once, purely by resolved identity.
  const edges: { from: Unit; to: Unit }[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!path.resolve(sf.fileName).startsWith(path.resolve(root))) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        let callee: ts.Expression = node.expression;
        while (ts.isNonNullExpression(callee) || ts.isParenthesizedExpression(callee)) callee = callee.expression;
        const sym = aliasResolve(checker, checker.getSymbolAtLocation(callee));
        for (const d of sym?.declarations ?? []) {
          const dsf = d.getSourceFile();
          if (!path.resolve(dsf.fileName).startsWith(path.resolve(root))) continue;
          // `new X()` reaches X's constructor(s) if declared, else the class itself.
          let targetsForEdge: ts.Node[] = [d];
          if (ts.isNewExpression(node) && ts.isClassDeclaration(d)) {
            const ctors = d.members.filter(ts.isConstructorDeclaration);
            targetsForEdge = ctors.length ? [d, ...ctors] : [d];
          }
          for (const t of targetsForEdge) {
            edges.push({ from: enclosingUnit(node, sf, root), to: unitOfDeclaration(t, root) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  // Fixed point over unit identity (never over names).
  const impacted = new Map<string, string>(); // unit key -> file
  for (const t of targets) {
    const u = unitOfDeclaration(t, root);
    impacted.set(u.key, u.file);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      if (impacted.has(e.to.key) && !impacted.has(e.from.key)) {
        impacted.set(e.from.key, e.from.file);
        changed = true;
      }
    }
  }
  const files = new Set<string>(impacted.values());
  files.add(declFile.replace(/\\/g, "/"));
  return [...files].sort();
}

export const IDENTITY_ORACLE_SOURCE_FILES = [path.resolve(path.dirname(new URL(import.meta.url).pathname), "oracles-identity.ts")];
