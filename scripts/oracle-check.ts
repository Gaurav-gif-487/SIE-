import path from "node:path";
import { loadLabelFile, manualOracle, typeDirectedOracle, languageServiceOracle, agreement } from "../src/groundtruth/oracles.js";
const repos = [
  { root: path.resolve(import.meta.dirname, "../tests/fixtures/repo-a"), labels: path.resolve(import.meta.dirname, "../tests/groundtruth/repo-a.labels.json") },
  { root: path.resolve(import.meta.dirname, "../tests/fixtures/repo-b"), labels: path.resolve(import.meta.dirname, "../tests/groundtruth/repo-b.labels.json") },
];
for (const r of repos) {
  const labels = loadLabelFile(r.labels);
  for (const t of labels.targets) {
    const m = manualOracle(labels, t.symbol)!;
    const td = typeDirectedOracle(r.root, t.symbol);
    const ls = languageServiceOracle(r.root, t.symbol);
    console.log(JSON.stringify({ repo: path.basename(r.root), symbol: t.symbol, manual: m.groundTruth, typeDirected: td.groundTruth, ls: ls.groundTruth, vsTD: agreement(m, td), vsLS: agreement(m, ls) }));
  }
}
