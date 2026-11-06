import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listSourceFiles, rel } from "../acquisition/program.js";

/**
 * CONVENTIONAL baseline: what a normal code-intelligence pipeline does.
 *
 *  FindCallers   -> IDE "find all references", filtered to call sites
 *  FindCallees   -> lexical scan of the body, name index
 *  Import/Call/TestImpact -> one-hop regex import graph over the repository
 *                             (the conventional baseline doesn't distinguish
 *                             import/call/test impact any more than a
 *                             typical non-type-aware pipeline would; see
 *                             arm.ts for how the same answer is reused
 *                             across all three impact task types)
 *
 * No type-directed dispatch reasoning, no uncertainty accounting, no planning.
 */

/**
 * Public reimplementation of the internal (unexported) `ts.getTokenAtPosition`.
 * Descends from the source file root into whichever child node's span contains
 * `pos`, stopping at a leaf (a node with no children) — i.e. the token at `pos`.
 */
function getTokenAtPosition(sf: ts.SourceFile, pos: number): ts.Node {
  let current: ts.Node = sf;
  outer: while (true) {
    for (const child of current.getChildren(sf)) {
      if (child.getStart(sf) <= pos && pos < child.getEnd()) {
        current = child;
        continue outer;
      }
    }
    return current;
  }
}

function service(root: string) {
  const files = listSourceFiles(root);
  const options: ts.CompilerOptions = {
    allowJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: false,
  };
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => {
      try {
        return ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8"));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return { svc: ts.createLanguageService(host, ts.createDocumentRegistry()), files, options };
}

export function conventionalFindCallers(root: string, symbol: string): string[] {
  const { svc, files } = service(root);
  const program = svc.getProgram()!;
  const sites = new Set<string>();
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const visit = (node: ts.Node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && node.name.getText(sf) === symbol) {
        const refs = svc.findReferences(file, node.name.getStart(sf)) ?? [];
        for (const group of refs) {
          for (const entry of group.references) {
            const rsf = program.getSourceFile(entry.fileName);
            if (!rsf) continue;
            const token = getTokenAtPosition(rsf, entry.textSpan.start);
            let p: ts.Node | undefined = token;
            let isCall = false;
            while (p && p.getStart(rsf) <= entry.textSpan.start + 200) {
              if (ts.isCallExpression(p) && p.expression.getEnd() >= entry.textSpan.start + entry.textSpan.length) {
                isCall = true;
                break;
              }
              p = p.parent;
            }
            if (!isCall) continue;
            if (entry.fileName === file && entry.textSpan.start === node.name.getStart(sf)) continue;
            sites.add(`${rel(root, entry.fileName)}:${rsf.getLineAndCharacterOfPosition(entry.textSpan.start).line + 1}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return [...sites].sort();
}

export function conventionalFindCallees(root: string, symbol: string): string[] {
  const files = listSourceFiles(root);
  const declaredNames = new Set<string>();
  const sources = new Map<string, ts.SourceFile>();
  for (const f of files) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.ES2022, true);
    sources.set(f, sf);
    const visit = (node: ts.Node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) declaredNames.add(node.name.getText(sf));
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  const out = new Set<string>();
  for (const [, sf] of sources) {
    const visit = (node: ts.Node) => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && node.name.getText(sf) === symbol) {
        const body = (node as ts.FunctionLikeDeclaration).body;
        if (body) {
          const inner = (n: ts.Node) => {
            if (ts.isCallExpression(n)) {
              const c = n.expression;
              const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : null;
              if (name && declaredNames.has(name)) out.add(name);
            }
            ts.forEachChild(n, inner);
          };
          ts.forEachChild(body, inner);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return [...out].sort();
}

const IMPORT_RE = /(?:from|import|require\()\s*['"]([^'"]+)['"]/g;

export function conventionalImpact(root: string, symbol: string): string[] {
  const files = listSourceFiles(root);
  let origin: string | null = null;
  const text = new Map<string, string>();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    text.set(f, src);
    if (!origin && new RegExp(`(function|\\b)\\s*${symbol}\\s*[(<]`).test(src)) origin = f;
  }
  if (!origin) return [];
  const importers: string[] = [];
  const originBase = path.basename(origin).replace(/\.(ts|tsx|js|jsx|mts|cts)$/, "");
  for (const f of files) {
    if (f === origin) continue;
    const src = text.get(f)!;
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1]!;
      if (!spec.startsWith(".")) continue;
      const base = path.basename(spec).replace(/\.(js|ts)$/, "");
      if (base === originBase) {
        importers.push(rel(root, f));
        break;
      }
    }
  }
  return [rel(root, origin), ...importers].sort();
}
