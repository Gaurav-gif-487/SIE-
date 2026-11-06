/**
 * Phases 2-4/6/7 driver: the "decision-needed" benchmark.
 *
 * For every hand-labelled task in tests/fixtures/repo-decision (ground truth:
 * tests/groundtruth/repo-decision.labels.json, written by inspection and never
 * derived from engine output) run three arms — required-only, adaptive,
 * exhaustive — and record answer, score, analyses run, planner step traces,
 * per-step uncertainty before/after, predicted vs actual value, cost, stop
 * reason and residual risk.
 *
 * Cache isolation: a fresh mkdtemp cache directory per (task, arm), destroyed
 * immediately afterwards, so no arm can hydrate another's analysed snapshot.
 * Results are flushed to disk after EVERY (task, arm) so an externally killed
 * run leaves valid partial data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/engine/engine.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const REPO = path.join(ROOT, "tests/fixtures/repo-decision");
const LABELS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/groundtruth/repo-decision.labels.json"), "utf8"));
const OUT_DIR = path.join(ROOT, "results/raw");
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT = path.join(OUT_DIR, "phase3-decision-benchmark.json");

type Arm = "required-only" | "adaptive" | "exhaustive";
const ARMS: Arm[] = ["required-only", "adaptive", "exhaustive"];

function prf(answer: string[], truth: string[]) {
  const A = new Set(answer);
  const T = new Set(truth);
  const tp = [...A].filter((x) => T.has(x)).length;
  const precision = A.size ? tp / A.size : T.size ? 0 : 1;
  const recall = T.size ? tp / T.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp: A.size - tp, fn: T.size - tp };
}

interface Row {
  phase: string;
  task: string;
  taskClass: string;
  difficulty?: string;
  symbol: string;
  arm: Arm;
  answer: string[];
  hedged: string[];
  expected: string[];
  precision: number;
  recall: number;
  f1: number;
  falsePositives: string[];
  falseNegatives: string[];
  analysesRun: number;
  analysisSequence: string[];
  notRun: { analysis: string; reason: string }[];
  wallMs: number;
  peakRssBytes: number;
  uncertainty: number | null;
  sufficient: boolean;
  verdict: string;
  stopReason: string;
  residualRisk: { acceptable: boolean; criticalSites: number; factors: string[] };
  steps: unknown[];
  unresolvable?: boolean;
}

const rows: Row[] = [];
function flush() {
  fs.writeFileSync(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), repo: "repo-decision", complete: false, rows }, null, 2),
  );
}

function stepTrace(steps: any[]) {
  return steps.map((s) => ({
    iteration: s.iteration,
    selected: s.selected,
    predictedUtility: s.predictedUtility,
    predictedUncertaintyReduction: s.predictedUncertaintyReduction,
    predictedCostMs: s.predictedCostMs,
    uncertaintyBefore: s.uncertaintyBefore,
    uncertaintyAfter: s.uncertaintyAfter,
    actualUncertaintyReduction: s.actualUncertaintyReduction,
    actualCostMs: s.actualCost?.wallMs ?? null,
    predictionError: s.predictionError,
    riskBefore: s.riskBefore,
    riskAfter: s.riskAfter,
    skipped: s.skipped,
    stopReason: s.stopReason,
    candidates: (s.candidates ?? []).map((c: any) => ({
      analysis: c.analysis,
      reason: c.reason,
      predictedUtility: c.predictedUtility,
      valuePerSecond: c.valuePerSecond,
      priorMeasuredCostMs: c.priorMeasuredCostMs,
      decision: c.decision,
      feasible: c.feasible,
    })),
  }));
}

async function withEngine<T>(arm: Arm, fn: (e: Engine) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sie-decision-${arm}-`));
  try {
    const engine = new Engine(REPO, { plannerMode: arm as never, cacheDir: dir });
    if (engine.restoredFromCache !== 0) {
      throw new Error(`cache isolation violation: ${engine.restoredFromCache} file(s) restored into a fresh cache dir`);
    }
    return await fn(engine);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runFindCallees() {
  for (const [symbol, label] of Object.entries<any>(LABELS.findCallees)) {
    for (const arm of ARMS) {
      const t0 = process.hrtime.bigint();
      const o = await withEngine(arm, (e) => e.findCallees(symbol));
      const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
      // Scored answer = confirmed callees only (verification-gated), matching
      // the main harness. `possible` (virtual dispatch) findings are hedges.
      const confirmed = [...new Set(o.result.confirmed.map((c) => c.calleeName))].sort();
      const possible = [...new Set(o.result.possible.map((c) => c.calleeName))].sort();
      const expected: string[] = label.expected;
      const s = prf(confirmed, expected);
      rows.push({
        phase: "phase3-findcallees",
        task: `FindCallees:${symbol}`,
        taskClass: label.class,
        difficulty: label.difficulty,
        symbol,
        arm,
        answer: confirmed,
        hedged: possible,
        expected,
        ...s,
        falsePositives: confirmed.filter((x) => !expected.includes(x)),
        falseNegatives: expected.filter((x) => !confirmed.includes(x)),
        analysesRun: o.costByAnalysis.length,
        analysisSequence: o.costByAnalysis.map((c) => c.analysis),
        notRun: o.notRun,
        wallMs,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        uncertainty: o.uncertainty.value,
        sufficient: o.sufficient,
        verdict: o.verdict,
        stopReason: o.stopReason,
        residualRisk: {
          acceptable: o.risk.acceptable,
          criticalSites: o.risk.criticalSites,
          factors: o.risk.factors.map((f: any) => f.kind),
        },
        steps: stepTrace(o.steps as any[]),
        unresolvable: label.unresolvable,
      } as Row);
      flush();
      console.log(`FindCallees ${symbol} [${arm}] F1=${s.f1.toFixed(3)} analyses=${o.costByAnalysis.length} ${wallMs.toFixed(0)}ms`);
    }
  }
}

async function runCallImpact() {
  for (const [symbol, label] of Object.entries<any>(LABELS.callImpact)) {
    for (const arm of ARMS) {
      const t0 = process.hrtime.bigint();
      // CALL semantics (Phase 1.1 decision): references excluded.
      const o = await withEngine(arm, (e) => e.impactOfChange(symbol, 4, undefined, { includeReferences: false }));
      const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const answer = [...new Set(o.result.affectedFiles.map((f) => f.replace(/\\/g, "/")))].sort();
      const expected: string[] = label.expected;
      const s = prf(answer, expected);
      rows.push({
        phase: "phase3-callimpact",
        task: `CallImpact:${symbol}`,
        taskClass: label.class,
        symbol,
        arm,
        answer,
        hedged: [],
        expected,
        ...s,
        falsePositives: answer.filter((x) => !expected.includes(x)),
        falseNegatives: expected.filter((x) => !answer.includes(x)),
        analysesRun: o.costByAnalysis.length,
        analysisSequence: o.costByAnalysis.map((c) => c.analysis),
        notRun: o.notRun,
        wallMs,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        uncertainty: o.uncertainty.value,
        sufficient: o.sufficient,
        verdict: o.verdict,
        stopReason: o.stopReason,
        residualRisk: {
          acceptable: o.risk.acceptable,
          criticalSites: o.risk.criticalSites,
          factors: o.risk.factors.map((f: any) => f.kind),
        },
        steps: stepTrace(o.steps as any[]),
      } as Row);
      flush();
      console.log(`CallImpact ${symbol} [${arm}] F1=${s.f1.toFixed(3)} analyses=${o.costByAnalysis.length} ${wallMs.toFixed(0)}ms`);
    }
  }
}

async function main() {
  await runFindCallees();
  await runCallImpact();
  fs.writeFileSync(
    OUT,
    JSON.stringify({ generatedAt: new Date().toISOString(), repo: "repo-decision", complete: true, rows }, null, 2),
  );
  console.log(`\nwrote ${OUT} (${rows.length} rows)`);
}

void main();
