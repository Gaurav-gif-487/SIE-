/** Phase 1.1: does CallImpact need REFERENCES edges? Measured, not asserted. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/engine/engine.js";
import { callImpactOracle } from "../src/experiment/oracles-ext.js";
import { referenceImpactOracle } from "../src/experiment/oracles-ref.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");

function prf(answer: string[], truth: string[]) {
  const a = new Set(answer), t = new Set(truth);
  const tp = [...a].filter((x) => t.has(x)).length;
  const precision = a.size ? tp / a.size : t.size === 0 ? 1 : 0;
  const recall = t.size ? tp / t.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, fp: [...a].filter((x) => !t.has(x)), fn: [...t].filter((x) => !a.has(x)) };
}

const targets: { repo: string; root: string; symbols: string[] }[] = [
  { repo: "repo-ref", root: path.join(ROOT, "tests/fixtures/repo-ref"), symbols: ["target"] },
  // { repo: "ky", root: path.join(ROOT, "corpus/ky/source"), symbols: ["delay", "timeout", "isRawNetworkError", "stop", "normalizeRequestMethod"] },
];

const out: any[] = [];
for (const t of targets) {
  if (!fs.existsSync(t.root)) continue;
  for (const sym of t.symbols) {
    const callTruth = callImpactOracle(t.root, sym);
    const refTruth = referenceImpactOracle(t.root, sym);
    const row: any = { repo: t.repo, symbol: sym, callTruth, refTruth, arms: {} };
    for (const includeReferences of [true, false]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1-"));
      const engine = new Engine(t.root, { plannerMode: "exhaustive" as never, cacheDir: dir });
      const o = await engine.impactOfChange(sym, 4, undefined, { includeReferences });
      const answer = o.result.affectedFiles;
      row.arms[includeReferences ? "calls+refs" : "calls-only"] = {
        answer,
        vsCallOracle: prf(answer, callTruth),
        vsReferenceOracle: prf(answer, refTruth),
      };
      fs.rmSync(dir, { recursive: true, force: true });
    }
    out.push(row);
    console.log(t.repo, sym,
      "calls+refs vsCall F1", row.arms["calls+refs"].vsCallOracle.f1.toFixed(3),
      "| calls-only vsCall F1", row.arms["calls-only"].vsCallOracle.f1.toFixed(3),
      "| calls+refs vsRef F1", row.arms["calls+refs"].vsReferenceOracle.f1.toFixed(3));
    fs.writeFileSync(path.join(ROOT, "results/raw/phase1-refs-vs-calls.json"), JSON.stringify(out, null, 2));
  }
}
