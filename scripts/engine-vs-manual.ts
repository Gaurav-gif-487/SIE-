import path from "node:path";
import { Engine } from "../src/engine/engine.js";
import { loadLabelFile, manualOracle } from "../src/groundtruth/oracles.js";
for (const name of ["repo-a","repo-b"]) {
  const root = path.resolve(import.meta.dirname, "../tests/fixtures", name);
  const labels = loadLabelFile(path.resolve(import.meta.dirname, "../tests/groundtruth", `${name}.labels.json`));
  const engine = new Engine(root);
  for (const t of labels.targets) {
    const truth = manualOracle(labels, t.symbol)!.groundTruth;
    const r = await engine.findCallers(t.symbol);
    const got = [...new Set([...r.result.confirmed, ...r.result.possible].map(c=>`${c.callSite.file}:${c.callSite.line}`))].sort();
    const open = r.result.unresolvedSites.map(c=>`${c.callSite.file}:${c.callSite.line}`);
    console.log(name, t.symbol, "\n  truth", truth, "\n  got  ", got, "\n  FP", got.filter(g=>!truth.includes(g)), "FN", truth.filter(x=>!got.includes(x)), "open", open);
  }
}
