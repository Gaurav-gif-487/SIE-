import path from "node:path";
import ts from "typescript";
import { EntityKind, SourceLocation } from "../canonical/model.js";
import { rel } from "./program.js";

export function locOf(sf: ts.SourceFile, node: ts.Node, root: string): SourceLocation {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: rel(root, sf.fileName),
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

/** Stable declaration identity: kind + file + start offset + name. */
export function declarationId(kind: EntityKind, decl: ts.Node, name: string, root: string): string {
  const sf = decl.getSourceFile();
  return `${kind}:${rel(root, sf.fileName)}@${decl.getStart(sf)}:${name}`;
}

export function declarationKind(node: ts.Node): EntityKind | null {
  if (ts.isFunctionDeclaration(node)) return "Function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "Method";
  if (ts.isClassDeclaration(node)) return "Class";
  if (ts.isInterfaceDeclaration(node)) return "Interface";
  if (ts.isTypeAliasDeclaration(node)) return "Type";
  if (ts.isConstructorDeclaration(node)) return "Method";
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return "Method";
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return "Function";
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return "Function";
    return "Symbol";
  }
  if (ts.isPropertyDeclaration(node)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return "Method";
    return "Symbol";
  }
  return null;
}

export function declarationName(node: ts.Node): string | null {
  const named = node as ts.NamedDeclaration;
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  if (named.name && ts.isStringLiteral(named.name)) return named.name.text;
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return null;
}

/**
 * An arrow function or function expression has no `.name` of its own — `const
 * foo = () => {...}` and `class X { m = () => {...} }` get their identity
 * from the enclosing VariableDeclaration/PropertyDeclaration, not from the
 * function-literal node itself. `declarationKind`/`declarationName` (and the
 * acquisition-time entity registration in symbols.ts) already know how to
 * read a name off that enclosing node; callers that walk up the AST from a
 * call site (calls.ts's `enclosingDeclaration`) land on the bare
 * arrow/function-expression node, though, so without this redirect every
 * named arrow function looks anonymous and calls inside it get attributed to
 * whatever *actually* named declaration contains it (or the module) instead
 * of to itself — silently dropping it as a FindCallees/FindCallers boundary.
 * Purely inline/anonymous callbacks (array-callback args, Promise executors)
 * still correctly return the arrow node itself here, since their parent is
 * not a named declaration; `calls.ts` walks past those on purpose.
 */
export function namedDeclarationOf(node: ts.Node): ts.Node {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const p = node.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer === node) return p;
    if (
      p &&
      ts.isPropertyDeclaration(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.initializer === node
    )
      return p;
  }
  return node;
}

/** Owning class/interface name for members, else null. */
export function containerName(node: ts.Node): string | null {
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isClassExpression(parent)) {
      const name = (parent as ts.ClassDeclaration).name;
      return name ? name.text : "<anonymous>";
    }
    parent = parent.parent;
  }
  return null;
}

/** Nearest enclosing function-like/class-member declaration of a node. */
export function enclosingDeclaration(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isClassDeclaration(current) ||
      ts.isModuleDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

export function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  // `export const x = ...` puts the modifier on the statement
  const stmt = node.parent?.parent;
  if (stmt && ts.canHaveModifiers(stmt)) {
    const mods = ts.getModifiers(stmt);
    if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  }
  return false;
}

export function moduleIdFor(file: string): string {
  return `Module:${file.replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, "")}`;
}

export function resolveImportTarget(
  sf: ts.SourceFile,
  specifier: string,
  program: ts.Program,
  root: string,
): string | null {
  const resolved = ts.resolveModuleName(
    specifier,
    sf.fileName,
    program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  if (!resolved) return null;
  if (resolved.resolvedFileName.includes("/node_modules/")) return null;
  const abs = path.resolve(resolved.resolvedFileName);
  if (!abs.startsWith(path.resolve(root))) return null;
  return rel(root, abs);
}
