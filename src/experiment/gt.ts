import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { corpus, selectTasks, pinOf, REPO_ROOT } from "./dataset.js";
import { typeDirectedOracle } from "../groundtruth/oracles.js";
import { calleeOracle, importImpactOracle, callImpactOracle, testImpactOracle, ORACLE_SOURCE_FILES } from "./oracles-ext.js";

/**
 * Ground truth pass. Runs once per repository, in its own process, before any
 * system is measured. Systems never see this file while they run.
 */

const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../results");
fs.mkdirSync(outDir, { recursive: true });

/**
 * All oracle-implementation source read to compute the FindCallers,
 * FindCallees, ImportImpact, CallImpact, and TestImpact ground truth below.
 * Hashed into every `gt-*.json` as `provenance.oracleVersionHash`. If this
 * file's contents ever changes (a patch to any oracle, e.g. the constructor
 * handling `all-fixes.patch` added to `calleeOracle`) without regenerating
 * ground truth, the hash stamped in the stale `gt-*.json` will no longer
 * match a freshly computed one — that mismatch is what let a stale-oracle
 * scoring bug (`AdminService`/`FastRunner` constructor callees scored as
 * false positives against a pre-patch oracle) go undetected before.
 */
const PROVENANCE_SOURCE_FILES = [
  ...ORACLE_SOURCE_FILES,
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "../groundtruth/oracles.ts"),
];

export function oracleVersionHash(): string {
  const h = crypto.createHash("sha256");
  for (const f of [...PROVENANCE_SOURCE_FILES].sort()) {
    // Hash the repo-relative path so the digest is identical on every machine.
    h.update(path.relative(REPO_ROOT, f).split(path.sep).join("/"));
    h.update("\0");
    h.update(fs.readFileSync(f, "utf8"));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * `oracleVersionHash` is imported by `arm.ts` to verify a `gt-*.json` isn't
 * stale before scoring against it. That must be a side-effect-free import —
 * the generation pass below (which reads the whole corpus and overwrites
 * `results/gt-*.json`) has no business running just because something wanted
 * the hash function. Gate it on direct execution (`tsx src/experiment/gt.ts`
 * / `node ...`), the same way a `if __name__ == "__main__"` guard would.
 */
function isMainModule(): boolean {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return invoked === path.resolve(new URL(import.meta.url).pathname);
}

if (isMainModule()) {
  const only = process.argv[2];
  const corpusInfo: Record<string, unknown> = {};
  const versionHash = oracleVersionHash();

  for (const spec of corpus()) {
    if (only && spec.id !== only) continue;
    const tasks = selectTasks(spec);
    const gt: Record<string, string[]> = {};
    for (const t of tasks) {
      const key = `${t.type}:${t.symbol}`;
      try {
        if (t.type === "FindCallers") gt[key] = typeDirectedOracle(spec.root, t.symbol).groundTruth;
        else if (t.type === "FindCallees") gt[key] = calleeOracle(spec.root, t.symbol);
        else if (t.type === "ImportImpact") gt[key] = importImpactOracle(spec.root, t.symbol);
        else if (t.type === "CallImpact") gt[key] = callImpactOracle(spec.root, t.symbol);
        else gt[key] = testImpactOracle(spec.root, t.symbol);
      } catch (e) {
        gt[key] = [];
        console.error(`oracle failed ${spec.id} ${key}: ${(e as Error).message}`);
      }
    }
    const pin = pinOf(spec);
    corpusInfo[spec.id] = { ...pin, size: spec.size, origin: spec.origin, tasks: tasks.length };
    fs.writeFileSync(
      path.join(outDir, `gt-${spec.id}.json`),
      JSON.stringify(
        {
          repo: spec.id,
          tasks,
          gt,
          provenance: {
            oracleVersionHash: versionHash,
            repositorySnapshot: { sha: pin.sha, files: pin.files, loc: pin.loc },
            generatedAt: new Date().toISOString(),
          },
        },
        null,
        2,
      ),
    );
    console.log(`ground truth: ${spec.id} ${tasks.length} tasks`);
  }
  fs.writeFileSync(path.join(outDir, "corpus.json"), JSON.stringify(corpusInfo, null, 2));
}
