/**
 * Phase 6 — verification / challenge layer ablation.
 *
 * Four configurations, same tasks, same ground truth:
 *   verify-off        : autoVerifyRecommended=false, criticality=low
 *   verify-on         : engine default (challenge runs when the policy says so)
 *   confirmed-only    : scored answer = confirmed findings only  (default scoring)
 *   confirmed+possible: scored answer = confirmed U possible (hedges asserted)
 *
 * The last two are scoring views over the verify-on run, not separate engine
 * configurations: the question is whether *withholding* hedged findings buys
 * precision at a recall cost, and whether the challenge itself changes the
 * answer at all or only annotates it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/engine/engine.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const REPO = path.join(ROOT, "tests/fixtures/repo-decision");
const LABELS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/groundtruth/repo-decision.labels.json"), "utf8"));
const OUT = path.join(ROOT, "results/raw/phase6-verification-ablation.json");

function prf(answer: string[], truth: string[]) {
  const A = new Set(answer);
  const T = new Set(truth);
  const tp = [...A].filter((x) => T.has(x)).length;
  const precision = A.size ? tp / A.size : T.size ? 0 : 1;
  const recall = T.size ? tp / T.size : 1;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

const rows: any[] = [];
function flush() {
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
}

async function run(config: "verify-off" | "verify-on", symbol: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sie-phase6-${config}-`));
  try {
    const engine = new Engine(REPO, {
      plannerMode: "adaptive",
      cacheDir: dir,
      verification: config === "verify-off" ? { autoVerifyRecommended: false, criticality: "low" } : { criticality: "normal" },
    });
    const t0 = process.hrtime.bigint();
    const o = await engine.findCallees(symbol);
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    return { o, wallMs };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  for (const [symbol, label] of Object.entries<any>(LABELS.findCallees)) {
    const expected: string[] = label.expected;
    for (const config of ["verify-off", "verify-on"] as const) {
      const { o, wallMs } = await run(config, symbol);
      const confirmed = [...new Set(o.result.confirmed.map((c) => c.calleeName))].sort();
      const possible = [...new Set(o.result.possible.map((c) => c.calleeName))].sort();
      const both = [...new Set([...confirmed, ...possible])].sort();
      const v: any = (o as any).verification ?? null;
      rows.push({
        symbol,
        taskClass: label.class,
        config,
        wallMs,
        analysesRun: o.costByAnalysis.length,
        verificationRan: !!v && v.ran === true,
        verificationRecord: v
          ? {
              ran: v.ran ?? null,
              decision: v.decision ?? null,
              method: v.challenge?.method ?? null,
              challengeCostMs: v.challenge?.costMs ?? v.challenge?.cost?.wallMs ?? null,
              comparisonOutcome: v.comparison?.outcome ?? null,
              agreements: v.comparison?.agreements ?? null,
              disagreements: v.comparison?.disagreements ?? null,
            }
          : null,
        finalStatus: (o as any).finalStatus ?? null,
        confirmedOnly: { answer: confirmed, ...prf(confirmed, expected) },
        confirmedPlusPossible: { answer: both, ...prf(both, expected) },
        expected,
      });
      flush();
      console.log(
        `${symbol} [${config}] confirmed F1=${prf(confirmed, expected).f1.toFixed(3)} conf+poss F1=${prf(both, expected).f1.toFixed(3)} ${wallMs.toFixed(0)}ms analyses=${o.costByAnalysis.length} ran=${v?.ran} decision=${JSON.stringify(v?.decision)}`,
      );
    }
  }
  console.log(`\nwrote ${OUT}`);
}

void main();
