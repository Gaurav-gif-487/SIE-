/**
 * ORACLE CHANGE (Phase 1, final validation) — new, additive file.
 *
 * `referenceImpactOracle`: the reference-semantics counterpart of
 * `callImpactOracle`. A declaration is impacted if its body *mentions* the
 * target symbol at all (call, construct, or bare value reference), run to
 * fixed point. It is a strict superset of call impact by construction.
 *
 * This file deliberately contains no engine code and is never imported by the
 * engine, so the CALLS-vs-REFERENCES decision can be measured without any
 * oracle/engine entanglement.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listSourceFiles, rel } from "../acquisition/program.js";

function createProgram(root: string): ts.Program {
  return ts.createProgram(listSourceFiles(root), {
    allowJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  });
}

function bodyOf(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) return node.body;
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer) return node.initializer;
  return undefined;
}
function nameOf(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isConstructorDeclaration(node)) {
    let p: ts.Node | undefined = node.parent;
    while (p && !ts.isClassDeclaration(p) && !ts.isClassExpression(p)) p = p.parent;
    return p && (ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name ? p.name.getText(sf) : null;
  }
  const n = (node as ts.NamedDeclaration).name;
  return n && ts.isIdentifier(n) ? n.getText(sf) : null;
}

export function referenceImpactOracle(root: string, symbol: string): string[] {
  const program = createProgram(root);
  // name -> declarations; declaration -> identifier names mentioned in its body
  const decls: { name: string; file: string; mentions: Set<string>; moduleLevel: boolean }[] = [];
  const originFiles = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!path.resolve(sf.fileName).startsWith(path.resolve(root))) continue;
    const moduleMentions = new Set<string>();
    const collect = (n: ts.Node, out: Set<string>) => {
      if (ts.isIdentifier(n)) out.add(n.text);
      ts.forEachChild(n, (c) => collect(c, out));
    };
    const visit = (node: ts.Node, inFn: boolean) => {
      const name = nameOf(node, sf);
      const body = bodyOf(node);
      if (name === symbol && (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node))) {
        originFiles.add(rel(root, sf.fileName));
      }
      if (name && body) {
        const mentions = new Set<string>();
        collect(body, mentions);
        decls.push({ name, file: rel(root, sf.fileName), mentions, moduleLevel: false });
        ts.forEachChild(node, (c) => visit(c, true));
        return;
      }
      if (ts.isClassDeclaration(node) && node.name) originFiles.add(node.name.text === symbol ? rel(root, sf.fileName) : "" as never);
      if (!inFn && !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) collect(node, moduleMentions);
      ts.forEachChild(node, (c) => visit(c, inFn));
    };
    visit(sf, false);
    decls.push({ name: `<module>${rel(root, sf.fileName)}`, file: rel(root, sf.fileName), mentions: moduleMentions, moduleLevel: true });
  }
  originFiles.delete("" as never);

  const reached = new Set<string>([symbol]);
  const files = new Set<string>(originFiles);
  const done = new Set<(typeof decls)[number]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of decls) {
      if (done.has(d) || reached.has(d.name)) continue;
      for (const r of reached) {
        if (d.mentions.has(r)) {
          // mark this declaration done exactly once, module-level included,
          // otherwise the fixed point never terminates (module-level pseudo
          // declarations would re-fire `changed` on every sweep).
          done.add(d);
          if (!d.moduleLevel) reached.add(d.name);
          files.add(d.file);
          changed = true;
          break;
        }
      }
    }
  }
  void fs;
  return [...files].filter(Boolean).sort();
}
