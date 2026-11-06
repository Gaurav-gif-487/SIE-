import path from "node:path";
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { runBaselineFindCallers } from "../src/baseline/baseline.js";
import { buildFindCallersContext } from "../src/reasoning/context.js";
import { Resolution } from "../src/canonical/model.js";
import { analysisByName, runAnalysis } from "../src/analyses/library.js";
import { acquireCoverage, acquireRuntimeTrace } from "../src/acquisition/signals.js";
import { newCounters } from "../src/cost/measure.js";
import { loadLabelFile, manualOracle } from "../src/groundtruth/oracles.js";

const REPO = path.resolve(__dirname, "fixtures/repo-a");

/**
 * Ground truth comes from the independent label file, NOT from this test file
 * and never from engine output. tests/groundtruth/repo-a.labels.json was
 * hand-written from the fixture source and cross-checked against two other
 * oracles in tests/groundtruth.test.ts.
 */
const LABELS = loadLabelFile(path.resolve(__dirname, "groundtruth/repo-a.labels.json"));
const GROUND_TRUTH: Record<string, string[]> = Object.fromEntries(
  LABELS.targets.map((t) => [t.symbol, manualOracle(LABELS, t.symbol)!.groundTruth]),
);

function sites(list: { callSite: { file: string; line: number } }[]): string[] {
  return list.map((c) => `${c.callSite.file}:${c.callSite.line}`).sort();
}

describe("type-aware FindCallers against ground truth", () => {
  it("distinguishes same-named methods on different receiver types", async () => {
    const engine = new Engine(REPO);
    const fast = await engine.findCallers("FastRunner.run");
    const found = sites([...fast.result.confirmed, ...fast.result.possible]);
    expect(found).toEqual(GROUND_TRUTH["FastRunner.run"]);
    // SlowRunner.run's call site must NOT appear
    expect(found).not.toContain("src/consumer.ts:11");
  });

  it("resolves the alias re-export to the same declaration", async () => {
    const engine = new Engine(REPO);
    const out = await engine.findCallers("FastRunner.run");
    const aliasSite = [...out.result.confirmed, ...out.result.possible].find((c) => c.callSite.line === 16);
    expect(aliasSite).toBeDefined();
    expect(aliasSite!.resolution).toBe(Resolution.EXACT);
  });

  it("finds the overriding method called through the subclass", async () => {
    const engine = new Engine(REPO);
    const out = await engine.findCallers("AdminService.authenticate");
    expect(sites([...out.result.confirmed, ...out.result.possible])).toEqual(
      GROUND_TRUTH["AdminService.authenticate"],
    );
  });

  it("reports interface-typed calls as possible, not confirmed", async () => {
    const engine = new Engine(REPO);
    const out = await engine.findCallers("Runner.run");
    const all = [...out.result.confirmed, ...out.result.possible];
    expect(all.some((c) => c.callSite.line === 20)).toBe(true);
    expect(out.result.confirmed.some((c) => c.callSite.line === 20)).toBe(false);
  });

  it("exposes dynamic dispatch and reflection as residual risk instead of guessing", async () => {
    const engine = new Engine(REPO);
    const out = await engine.findCallers("FastRunner.run");
    const kinds = out.risk.factors.map((f) => f.kind);
    expect(kinds).toContain("dynamic-dispatch");
    expect(kinds).toContain("reflection");
    // Those sites cannot reach FastRunner.run's name, so they are reported as
    // risk factors but do not make this particular answer unsafe.
    expect(out.risk.criticalSites).toBe(0);
    expect(out.uncertainty.value === null || out.uncertainty.value >= 0).toBe(true);
  });

  it("returns UNKNOWN target selection for a symbol that does not exist", async () => {
    const engine = new Engine(REPO);
    const out = await engine.findCallers("noSuchSymbol");
    expect(out.result.targetSelectionStatus).toBe("UNKNOWN");
    expect(out.result.confirmed).toHaveLength(0);
    const pack = buildFindCallersContext(engine.store, out.result, out.uncertainty, out.risk);
    expect(pack.llmStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(pack.items).toHaveLength(0);
  });
});

describe("planner adaptivity", () => {
  it("Case B: resolves types before calls (dependency-aware ordering)", async () => {
    const engine = new Engine(REPO);
    const out = await engine.findCallers("FastRunner.run");
    const order = out.steps.map((s) => s.selected).filter(Boolean) as string[];
    expect(order.indexOf("ResolveTypes")).toBeGreaterThan(-1);
    expect(order.indexOf("ResolveTypes")).toBeLessThan(order.indexOf("ResolveCalls"));
    expect(order.indexOf("ResolveSymbols")).toBeLessThan(order.indexOf("ResolveTypes"));
  });

  it("Case A: does not recompute analyses whose evidence already exists", async () => {
    const engine = new Engine(REPO);
    const first = await engine.findCallers("FastRunner.run");
    const second = await engine.findCallers("SlowRunner.run");
    const firstRan = first.steps.filter((s) => s.selected).map((s) => s.selected);
    const secondRan = second.steps.filter((s) => s.selected).map((s) => s.selected);
    expect(firstRan).toContain("ResolveCalls");
    expect(secondRan).not.toContain("ResolveCalls");
    expect(second.totalCost.wallClockMs).toBeLessThan(first.totalCost.wallClockMs);
  });

  it("Case C: never invokes an LLM or embeddings when static evidence answers the task", async () => {
    const engine = new Engine(REPO);
    const out = await engine.findCallers("FastRunner.run");
    expect(out.totalCost.llmCalls).toBe(0);
    expect(out.totalCost.llmTokens).toBe(0);
    const pack = buildFindCallersContext(engine.store, out.result, out.uncertainty, out.risk);
    expect(pack.llmStatus).toBe("NOT_INVOKED_NO_MODEL_CONFIGURED");
  });

  it("Case D: unfinished evidence (interface-typed call) drives additional analysis", async () => {
    const engine = new Engine(REPO);
    const out = await engine.findCallers("Runner.run");
    const selected = out.steps.map((s) => s.selected).filter(Boolean) as string[];
    expect(out.uncertainty.value === null || out.uncertainty.value > 0).toBe(true);
    expect(selected).toContain("AnalyzeInheritance");
    expect(out.stopReason).toBeTruthy();
  });

  it("records predicted utility and measured cost for every executed step", async () => {
    const engine = new Engine(REPO);
    const out = await engine.findCallers("FastRunner.run");
    for (const step of out.steps.filter((s) => s.selected)) {
      expect(step.predictedUtility).not.toBeNull();
      expect(step.actualCost!.wallClockMs).toBeGreaterThan(0);
    }
  });
});

describe("evidence and provenance", () => {
  it("attaches source, location, revision and derivation to every fact", async () => {
    const engine = new Engine(REPO);
    const out = await engine.findCallers("FastRunner.run");
    expect(out.result.evidence.length).toBeGreaterThan(0);
    for (const ev of out.result.evidence) {
      expect(ev.source).toBeTruthy();
      expect(ev.sourceType).toBe("typescript-compiler");
      expect(ev.location).not.toBeNull();
      expect(ev.revision).toBeTruthy();
      expect(ev.derivation).toBeTruthy();
      expect(ev.producedBy).toBeTruthy();
    }
  });

  it("reports missing runtime and coverage inputs as UNKNOWN, never fabricates them", async () => {
    const engine = new Engine(REPO);
    await engine.index();
    await runAnalysis(analysisByName("AnalyzeGitHistory"), engine.context);
    const cov = acquireCoverage(null, engine.root, engine.store, newCounters());
    const trace = acquireRuntimeTrace(null, engine.store, newCounters());
    expect(cov.available).toBe(false);
    expect(trace.available).toBe(false);
    expect(engine.store.entitiesOfKind("RuntimeEvent")).toHaveLength(0);
    expect(engine.store.unknownRegions("no-coverage-data")).toHaveLength(1);
    expect(engine.store.unknownRegions("no-runtime-data")).toHaveLength(1);
  });

  it("invalidates knowledge for changed files (incremental computation)", async () => {
    const engine = new Engine(REPO);
    await engine.index();
    const before = engine.store.summary().files;
    engine.store.recordFileHash("src/consumer.ts", "deadbeef");
    const refreshed = engine.refresh();
    expect(refreshed.stale).toContain("src/consumer.ts");
    expect(engine.store.summary().files).toBeLessThanOrEqual(before);
  });
});

describe("baseline comparison", () => {
  it("the baseline over-reports because it matches names, the engine does not", async () => {
    const baseline = await runBaselineFindCallers(REPO, "FastRunner.run");
    const baselineSites = baseline.callers.map((c) => `${c.file}:${c.line}`).sort();
    const engine = new Engine(REPO);
    const adaptive = await engine.findCallers("FastRunner.run");
    const adaptiveSites = sites([...adaptive.result.confirmed, ...adaptive.result.possible]);

    const truth = GROUND_TRUTH["FastRunner.run"]!;
    const baselineFalsePositives = baselineSites.filter((s) => !truth.includes(s));
    const adaptiveFalsePositives = adaptiveSites.filter((s) => !truth.includes(s));
    expect(baselineFalsePositives.length).toBeGreaterThan(adaptiveFalsePositives.length);
    expect(adaptiveFalsePositives).toHaveLength(0);
    expect(baseline.cost.wallClockMs).toBeGreaterThan(0);
  });
});
