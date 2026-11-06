import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { corpus } from "./dataset.js";

/**
 * Experiment driver. Each (repo, system, workload) arm runs in a fresh process
 * with a hard timeout; arms that exceed it are recorded as timed-out rather
 * than silently dropped.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const RESULTS = path.join(ROOT, "results");
fs.mkdirSync(RESULTS, { recursive: true });

const SYSTEMS = ["required-only", "adaptive", "exhaustive", "conventional"] as const;
const WORKLOADS = ["cold", "warm"] as const;
const TIMEOUT_MS = Number(process.env["ARM_TIMEOUT_MS"] ?? 900_000);

function runArm(repo: string, system: string, workload: string, out: string): Promise<{ ok: boolean; ms: number; note: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=6144",
        path.join(ROOT, "node_modules/tsx/dist/cli.mjs"),
        path.join(ROOT, "src/experiment/arm.ts"),
        "--repo",
        repo,
        "--system",
        system,
        "--workload",
        workload,
        "--out",
        out,
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += String(d).slice(0, 2000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      resolve({ ok: code === 0 && fs.existsSync(out), ms, note: code === 0 ? "" : `exit=${code} ${err.slice(-400)}` });
    });
  });
}

async function main() {
  const only = process.env["ONLY_REPOS"]?.split(",");
  const index: Record<string, unknown> = fs.existsSync(path.join(RESULTS, "arms.json"))
    ? JSON.parse(fs.readFileSync(path.join(RESULTS, "arms.json"), "utf8"))
    : {};
  for (const spec of corpus()) {
    if (only && !only.includes(spec.id)) continue;
    for (const workload of WORKLOADS) {
      for (const system of SYSTEMS) {
        const key = `${spec.id}|${system}|${workload}`;
        const out = path.join(RESULTS, `arm-${spec.id}-${system}-${workload}.json`);
        if (fs.existsSync(out)) {
          console.log(`skip (exists) ${key}`);
          continue;
        }
        const r = await runArm(spec.id, system, workload, out);
        index[key] = r;
        fs.writeFileSync(path.join(RESULTS, "arms.json"), JSON.stringify(index, null, 2));
        console.log(`${r.ok ? "ok  " : "FAIL"} ${key} ${(r.ms / 1000).toFixed(1)}s ${r.note}`);
      }
    }
  }
}

void main();
