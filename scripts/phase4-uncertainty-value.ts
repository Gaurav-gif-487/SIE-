/**
 * Phase 4 — does the planner's uncertainty actually predict marginal value?
 *
 * Part A: aggregate the step traces recorded by phase3-decision-benchmark.ts
 *         into the predicted-vs-actual table the phase asks for.
 * Part B: memory-warming probe. Part A can only measure what the planner
 *         actually had available; PlannerMemory starts empty in every cold
 *         arm, so `valuePerSecond` is null by construction on a first run.
 *         Part B shares one PlannerMemory across repeated runs of the same
 *         task so the planner has measured expectations, and asks whether
 *         that changes any decision or any answer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/engine/engine.js";
import { PlannerMemory } from "../src/planning/memory.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const REPO = path.join(ROOT, "tests/fixtures/repo-decision");
const P3 = path.join(ROOT, "results/raw/phase3-decision-benchmark.json");
const OUT = path.join(ROOT, "results/raw/phase4-uncertainty-value.json");

const p3 = JSON.parse(fs.readFileSync(P3, "utf8"));

// ---- Part A -------------------------------------------------------------
interface Cand {
  task: string;
  arm: string;
  iteration: number;
  analysis: string;
  reason: string;
  predictedUtility: number;
  predictedValuePerSecond: number | null;
  priorMeasuredCostMs: number | null;
  decision: string;
  selected: boolean;
  uncertaintyBefore: number | null;
  uncertaintyAfter: number | null;
  actualUncertaintyReduction: number | null;
  actualCostMs: number | null;
}
const cands: Cand[] = [];
for (const row of p3.rows) {
  for (const s of row.steps as any[]) {
    for (const c of s.candidates) {
      cands.push({
        task: row.task,
        arm: row.arm,
        iteration: s.iteration,
        analysis: c.analysis,
        reason: c.reason,
        predictedUtility: c.predictedUtility,
        predictedValuePerSecond: c.valuePerSecond,
        priorMeasuredCostMs: c.priorMeasuredCostMs,
        decision: c.decision,
        selected: s.selected === c.analysis,
        uncertaintyBefore: s.uncertaintyBefore,
        uncertaintyAfter: s.uncertaintyAfter,
        actualUncertaintyReduction: s.selected === c.analysis ? s.actualUncertaintyReduction : null,
        actualCostMs: s.selected === c.analysis ? s.actualCostMs : null,
      });
    }
  }
}
const steps = p3.rows.flatMap((r: any) => r.steps);
const partA = {
  totalRows: p3.rows.length,
  totalSteps: steps.length,
  totalCandidateEvaluations: cands.length,
  stepsWithUncertaintyBefore: steps.filter((s: any) => s.uncertaintyBefore !== null).length,
  stepsWithMeasuredUncertaintyReduction: steps.filter((s: any) => s.actualUncertaintyReduction !== null).length,
  candidatesWithValuePerSecond: cands.filter((c) => c.predictedValuePerSecond !== null).length,
  candidatesWithPriorCost: cands.filter((c) => c.priorMeasuredCostMs !== null).length,
  decisionHistogram: cands.reduce((m: Record<string, number>, c) => ((m[c.decision] = (m[c.decision] ?? 0) + 1), m), {}),
  reasonHistogram: cands.reduce((m: Record<string, number>, c) => ((m[c.reason] = (m[c.reason] ?? 0) + 1), m), {}),
};

// ---- Part B -------------------------------------------------------------
async function warmProbe() {
  const memory = new PlannerMemory();
  const symbols = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "tests/groundtruth/repo-decision.labels.json"), "utf8")).findCallees);
  const iterations: any[] = [];
  for (let round = 0; round < 3; round++) {
    for (const symbol of symbols) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sie-phase4-`));
      try {
        const engine = new Engine(REPO, { plannerMode: "adaptive", plannerMemory: memory, cacheDir: dir });
        const t0 = process.hrtime.bigint();
        const o = await engine.findCallees(symbol);
        const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
        const cs = (o.steps as any[]).flatMap((s) =>
          s.candidates.map((c: any) => ({
            analysis: c.analysis,
            valuePerSecond: c.valuePerSecond,
            priorMeasuredCostMs: c.priorMeasuredCostMs,
            decision: c.decision,
          })),
        );
        iterations.push({
          round,
          symbol,
          wallMs,
          analyses: o.costByAnalysis.map((c) => c.analysis),
          answer: [...new Set(o.result.confirmed.map((c) => c.calleeName))].sort(),
          candidatesWithValuePerSecond: cs.filter((c) => c.valuePerSecond !== null).length,
          candidatesWithPriorCost: cs.filter((c) => c.priorMeasuredCostMs !== null).length,
          notWorthCost: cs.filter((c) => c.decision === "not-worth-cost").map((c) => c.analysis),
          deferred: cs.filter((c) => c.decision === "deferred-lower-value").map((c) => c.analysis),
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return iterations;
}

async function main() {
  const partB = await warmProbe();
  fs.writeFileSync(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), partA, candidates: cands, partB }, null, 2),
  );
  console.log("Part A (cold arms, from phase3 traces):");
  console.log(JSON.stringify(partA, null, 2));
  console.log("\nPart B (shared PlannerMemory across 3 rounds):");
  for (const r of partB) {
    console.log(
      `  round=${r.round} ${r.symbol} analyses=${r.analyses.length} vps-informed-candidates=${r.candidatesWithValuePerSecond} priorCost=${r.candidatesWithPriorCost} notWorthCost=[${r.notWorthCost.join(",")}] ${r.wallMs.toFixed(0)}ms`,
    );
  }
  const byRound = [0, 1, 2].map((rd) => {
    const rows = partB.filter((r: any) => r.round === rd);
    return {
      round: rd,
      meanAnalyses: rows.reduce((a: number, r: any) => a + r.analyses.length, 0) / rows.length,
      informed: rows.reduce((a: number, r: any) => a + r.candidatesWithValuePerSecond, 0),
      answersIdenticalToRound0: rows.every((r: any) => {
        const base = partB.find((x: any) => x.round === 0 && x.symbol === r.symbol)!;
        return JSON.stringify(base.answer) === JSON.stringify(r.answer);
      }),
    };
  });
  console.log("\nper-round summary:", JSON.stringify(byRound));
  console.log(`wrote ${OUT}`);
}

void main();
