import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CostRecord, measure } from "../cost/measure.js";
import { Bm25Index } from "../search/search.js";
import { listSourceFiles, rel } from "../acquisition/program.js";

/**
 * Baseline execution mode: the conventional pipeline.
 *
 *   index everything -> lexical retrieve -> build context -> (LLM if required)
 *
 * It is deliberately NOT crippled: it parses every file with the real
 * TypeScript parser and finds every call expression whose callee name matches.
 * What it does not do is use type information, so `a.run()` and `b.run()` are
 * indistinguishable to it. That is the conventional behaviour we compare against.
 */

export interface BaselineCaller {
  file: string;
  line: number;
  column: number;
  callerName: string;
  calleeText: string;
}

export interface BaselineOutcome {
  symbol: string;
  callers: BaselineCaller[];
  cost: CostRecord;
  filesIndexed: number;
  callExpressions: number;
  bm25Docs: number;
  llmCalls: number;
  llmTokens: number;
}

function enclosingName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    const named = cur as ts.NamedDeclaration;
    if (
      (ts.isFunctionDeclaration(cur) ||
        ts.isMethodDeclaration(cur) ||
        ts.isConstructorDeclaration(cur) ||
        ts.isArrowFunction(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isVariableDeclaration(cur)) &&
      named.name &&
      ts.isIdentifier(named.name)
    ) {
      return named.name.text;
    }
    if (ts.isConstructorDeclaration(cur)) return "constructor";
    cur = cur.parent;
  }
  return "<module-top-level>";
}

export async function runBaselineFindCallers(root: string, symbol: string): Promise<BaselineOutcome> {
  const resolved = path.resolve(root);
  const name = symbol.includes(".") ? symbol.slice(symbol.lastIndexOf(".") + 1) : symbol;

  const { value, cost } = await measure("BaselineFindCallers", (counters) => {
    const files = listSourceFiles(resolved);
    // Whole-repository index (conventional: index first, ask later).
    const bm25 = new Bm25Index(resolved, files);
    const callers: BaselineCaller[] = [];
    let callExpressions = 0;

    for (const file of files) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, scriptKind(file));
      counters.filesProcessed += 1;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          callExpressions += 1;
          const calleeText = node.expression.getText(sf);
          const last = calleeText.split(".").pop() ?? calleeText;
          if (last === name) {
            const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            callers.push({
              file: rel(resolved, file),
              line: pos.line + 1,
              column: pos.character + 1,
              callerName: enclosingName(node),
              calleeText,
            });
            counters.symbolsProcessed += 1;
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(sf, visit);
    }
    return { callers, filesIndexed: files.length, callExpressions, bm25Docs: bm25.size };
  });

  return {
    symbol,
    callers: value.callers,
    cost,
    filesIndexed: value.filesIndexed,
    callExpressions: value.callExpressions,
    bm25Docs: value.bm25Docs,
    llmCalls: 0,
    llmTokens: 0,
  };
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
