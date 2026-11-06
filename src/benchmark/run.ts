/**
 * Real-repository benchmark. Ground truth for each target is produced by an
 * INDEPENDENT oracle: the TypeScript language service's findReferences,
 * filtered to call sites. Nothing here is hardcoded.
 */
import path from "node:path";
import ts from "typescript";
import { Engine } from "../engine/engine.js";
import { runBaselineFindCallers } from "../baseline/baseline.js";
import { listSourceFiles, rel } from "../acquisition/program.js";

function oracle(root: string, symbol: string): string[] {
  const files = listSourceFiles(root).map((f) => path.resolve(f));
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => {
      const text = ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, strict: true }),
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
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === name) {
        let owner: string | null = null;
        let p: ts.Node | undefined = node.parent;
        while (p) { if (ts.isClassDeclaration(p) && p.name) { owner = p.name.text; break; } p = p.parent; }
        if (container === null || owner === container) {
          const refs = service.findReferences(sf.fileName, node.name.getStart(sf)) ?? [];
          for (const group of refs) {
            for (const entry of group.references) {
              if (entry.isDefinition) continue;
              const target = program.getSourceFile(entry.fileName);
              if (!target) continue;
              const node2 = findNodeAt(target, entry.textSpan.start);
              if (!node2) continue;
              const isCall = node2.parent && ((ts.isCallExpression(node2.parent) && node2.parent.expression === node2) ||
                (ts.isPropertyAccessExpression(node2.parent) && ts.isCallExpression(node2.parent.parent) && node2.parent.parent.expression === node2.parent));
              if (!isCall) continue;
              const call = ts.isCallExpression(node2.parent!) ? node2.parent! : node2.parent!.parent;
              const pos = target.getLineAndCharacterOfPosition(call.getStart(target));
              sites.add(`${rel(root, target.fileName)}:${pos.line + 1}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return [...sites].sort();
}

function findNodeAt(sf: ts.SourceFile, pos: number): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (n: ts.Node): void => {
    if (n.getStart(sf) <= pos && pos < n.getEnd()) { if (ts.isIdentifier(n)) found = n; ts.forEachChild(n, visit); }
  };
  ts.forEachChild(sf, visit);
  return found;
}

function score(found: string[], truth: string[]) {
  const tp = found.filter((f) => truth.includes(f)).length;
  const fp = found.filter((f) => !truth.includes(f)).length;
  const fn = truth.filter((t) => !found.includes(t)).length;
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, fp, fn, precision, recall, f1 };
}

const CASES: { repo: string; symbols: string[] }[] = [
  { repo: path.resolve(import.meta.dirname, "../../tests/fixtures/repo-a"), symbols: ["FastRunner.run", "SlowRunner.run", "AdminService.authenticate", "useFast"] },
  { repo: path.resolve(import.meta.dirname, "../.."), symbols: ["acquireCalls", "acquireSymbols", "KnowledgeStore.addEvidence", "findCallersTask", "measure"] },
];

const rows: unknown[] = [];
for (const { repo, symbols } of CASES) {
  const engine = new Engine(repo);
  for (const symbol of symbols) {
    const truth = oracle(repo, symbol);
    const adaptive = await engine.findCallers(symbol);
    const adaptiveSites = [...adaptive.result.confirmed, ...adaptive.result.possible]
      .map((c) => `${c.callSite.file}:${c.callSite.line}`)
      .sort();
    const baseline = await runBaselineFindCallers(repo, symbol);
    const baselineSites = [...new Set(baseline.callers.map((c) => `${c.file}:${c.line}`))].sort();
    rows.push({
      repo: path.basename(repo), symbol, groundTruthSites: truth.length,
      adaptive: { ...score(adaptiveSites, truth), latencyMs: Number(adaptive.totalCost.wallClockMs.toFixed(1)), heapDeltaMB: Number((adaptive.totalCost.heapUsedDeltaBytes / 1048576).toFixed(1)), filesAnalyzed: adaptive.totalCost.filesProcessed, symbolsAnalyzed: adaptive.totalCost.symbolsProcessed, llmCalls: adaptive.totalCost.llmCalls, llmTokens: adaptive.totalCost.llmTokens, uncertainty: adaptive.uncertainty.value, residualRiskCriticalSites: adaptive.risk.criticalSites, stopReason: adaptive.stopReason, analysesRun: adaptive.steps.map((s) => s.selected).filter(Boolean) },
      baseline: { ...score(baselineSites, truth), latencyMs: Number(baseline.cost.wallClockMs.toFixed(1)), heapDeltaMB: Number((baseline.cost.heapUsedDeltaBytes / 1048576).toFixed(1)), filesAnalyzed: baseline.filesIndexed, symbolsAnalyzed: baseline.cost.symbolsProcessed, llmCalls: baseline.llmCalls, llmTokens: baseline.llmTokens },
    });
  }
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, typescript: ts.version, rows }, null, 2));
