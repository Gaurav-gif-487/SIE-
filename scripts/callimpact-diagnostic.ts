import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Engine } from "../src/engine/engine.js";
import { repoById, selectTasks } from "../src/experiment/dataset.js";
import { callImpactOracle } from "../src/experiment/oracles-ext.js";

const REPO_IDS = process.argv[2] ? [process.argv[2]] : ["ky", "zod"];

function prf(pred: string[], gt: string[]) {
  const p = new Set(pred);
  const g = new Set(gt);
  const tp = [...p].filter((x) => g.has(x)).length;
  const fp = [...p].filter((x) => !g.has(x));
  const fn = [...g].filter((x) => !p.has(x));
  const precision = p.size ? tp / p.size : 1;
  const recall = g.size ? tp / g.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp, fn };
}

async function main() {
  for (const repoId of REPO_IDS) {
    const spec = repoById(repoId);
    const tasks = selectTasks(spec).filter((t) => t.type === "CallImpact");
    const symbols = [...new Set(tasks.map((t) => t.symbol))];
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `sie-diag-${repoId}-`));
    const engine = new Engine(spec.root, { cacheDir });
    console.log(`\n=== ${repoId} (${spec.root}) ===`);
    for (const symbol of symbols) {
      const oracleFiles = callImpactOracle(spec.root, symbol);
      let outcome;
      try {
        outcome = await engine.impactOfChange(symbol);
      } catch (e) {
        console.log(`  ${symbol}: ERROR ${(e as Error).message}`);
        continue;
      }
      const engineFiles = outcome.result.affectedFiles;
      const { precision, recall, f1, fp, fn } = prf(engineFiles, oracleFiles);
      console.log(
        `  ${symbol}: P=${precision.toFixed(2)} R=${recall.toFixed(2)} F1=${f1.toFixed(2)} ` +
          `(engine=${engineFiles.length}, oracle=${oracleFiles.length}, fp=${fp.length}, fn=${fn.length})`,
      );
      if (fp.length > 0) {
        // Categorize by resolution across ALL edges (global view first)
        const resCounts = new Map<string, number>();
        const kindCounts = new Map<string, number>();
        for (const edge of outcome.result.edges) {
          resCounts.set(edge.resolution, (resCounts.get(edge.resolution) ?? 0) + 1);
          kindCounts.set(edge.kind, (kindCounts.get(edge.kind) ?? 0) + 1);
        }
        console.log(`    edge resolutions: ${[...resCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
        console.log(`    edge kinds: ${[...kindCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
        // For each FP file, show which edges (kind) point into it
        for (const file of fp.slice(0, 5)) {
          const fpEdges = outcome.result.edges.filter((e) => e.fromName && (e as any).fromName);
          // find dependent entries whose file matches
          const relevant = [
            ...outcome.result.directDependents,
            ...outcome.result.transitiveDependents,
          ].filter((d) => d.file === file);
          const names = relevant.map((d) => d.name).slice(0, 5);
          const kindsForFile = outcome.result.edges.filter((e) =>
            [...outcome.result.directDependents, ...outcome.result.transitiveDependents].some(
              (d) => d.file === file && d.id === e.fromId,
            ),
          );
          const kindsSet = [...new Set(kindsForFile.map((e) => e.kind))];
          console.log(`      fp file ${file}: dependents=${names.join(",")} edgeKinds=${kindsSet.join(",")}`);
        }
      }
      if (fn.length > 0) {
        console.log(`    fn files (sample): ${fn.slice(0, 8).join(", ")}`);
      }
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
