import { KnowledgeStore } from "../knowledge/store.js";
import { Analysis, AnalysisContext, ANALYSES, analysisByName, runAnalysis } from "../analyses/library.js";
import { CostRecord, sumCost } from "../cost/measure.js";
import { Expectation, PlannerMemory } from "./memory.js";
import { ENGINE_FINGERPRINT, QueryCache } from "./query-cache.js";
import { ResidualRisk, TaskDefinition, Uncertainty } from "../tasks/find-callers.js";
import { Soundness } from "../canonical/model.js";

/**
 * Planning layer.
 *
 * Dependency-aware greedy selection. Analyses are never ranked purely by
 * gain/cost: an analysis is only a candidate once its dependencies are
 * satisfied, and unmet dependencies are themselves promoted to candidates.
 */

export interface Candidate {
  analysis: string;
  /** why it is feasible now */
  reason: "required-missing" | "dependency-of-required" | "risk-reduction" | "uncertainty-reduction";
  /** what kind of claim this analysis is entitled to make; see Soundness */
  soundness: Soundness;
  /** transparent deterministic heuristic, NOT a calibrated probability */
  predictedUtility: number;
  /** measured cost of this analysis from a previous run, else null (unknown) */
  priorMeasuredCostMs: number | null;
  feasible: boolean;
  blockedBy: string[];
  /** measured expectations from planner memory; observations=0 means never measured */
  expectation: Expectation;
  /**
   * Value of information, in uncertainty-points per second, computed from
   * measured means only. null when this analysis has never been measured for
   * this task type: an unmeasured option is explored, not scored.
   */
  valuePerSecond: number | null;
  decision: "selected" | "deferred-lower-value" | "blocked" | "not-worth-cost";
}

export interface PlannerStep {
  iteration: number;
  candidates: Candidate[];
  selected: string | null;
  skipped: string[];
  predictedUtility: number | null;
  actualCost: CostRecord | null;
  uncertaintyBefore: number | null;
  uncertaintyAfter: number | null;
  actualUncertaintyReduction: number | null;
  /** what memory predicted before running, for calibration measurement */
  predictedUncertaintyReduction: number | null;
  predictedCostMs: number | null;
  /** |predicted - actual| for uncertainty reduction; null when unmeasured before */
  predictionError: number | null;
  riskBefore: number;
  riskAfter: number;
  notes: string[];
  stopReason: string | null;
}

/**
 * A query never manufactures an answer it can't support. `verdict`
 * classifies why the outcome stopped where it did, independent of whatever
 * partial `result` was computed:
 *
 *   SUFFICIENT           - required evidence exists and residual risk is acceptable
 *   INSUFFICIENT_EVIDENCE - stopped (budget/iterations) before reaching that bar
 *   CONFLICTING_EVIDENCE  - sources disagree (e.g. runtime vs. static) and that
 *                           disagreement was never resolved
 *   HIGH_RESIDUAL_RISK    - evidence is otherwise complete but named risk
 *                           factors (reflection, dynamic dispatch, ...) remain
 *   ANALYSIS_UNSUPPORTED  - a required analysis could never become feasible
 *                           (e.g. missing input file, no git, no network)
 */
export type Verdict =
  | "SUFFICIENT"
  | "INSUFFICIENT_EVIDENCE"
  | "CONFLICTING_EVIDENCE"
  | "HIGH_RESIDUAL_RISK"
  | "ANALYSIS_UNSUPPORTED";

export interface PlanOutcome<TResult> {
  result: TResult;
  uncertainty: Uncertainty;
  risk: ResidualRisk;
  steps: PlannerStep[];
  totalCost: Omit<CostRecord, "analysis">;
  costByAnalysis: CostRecord[];
  stopReason: string;
  sufficient: boolean;
  /** mode this outcome was produced under */
  mode: PlannerMode;
  /** mean absolute error of the planner's own uncertainty-reduction predictions */
  calibration: { predictions: number; meanAbsoluteError: number | null };
  /** analyses deliberately not run, with the reason */
  notRun: { analysis: string; reason: string }[];
  /** true when this outcome was served from the query cache instead of re-planned */
  cacheHit: boolean;
  /** why the outcome stopped where it did; never manufactures SUFFICIENT */
  verdict: Verdict;
}

/**
 * Planning modes. `adaptive` is the thesis under test; the other two are the
 * controls it has to beat on the accuracy/cost frontier.
 */
export type PlannerMode = "adaptive" | "exhaustive" | "required-only";

export interface PlannerOptions {
  maxIterations?: number;
  mode?: PlannerMode;
  /** stop when the cumulative measured wall clock exceeds this budget */
  budgetMs?: number | null;
  /**
   * Minimum measured value of information, in uncertainty-points per second,
   * that justifies running another analysis. 0 keeps every positive-value
   * option; raising it buys cost at the price of certainty.
   */
  marginalValueFloor?: number;
  memory?: PlannerMemory;
  /**
   * Computation memory at the task level: when set, a query for the same
   * task type + target against an unchanged revision is returned without
   * re-running the planner loop at all.
   */
  queryCache?: QueryCache;
}

/** Utility heuristics are explicit and documented; they are not calibrated. */
function predictUtility(analysis: Analysis, reason: Candidate["reason"], risk: ResidualRisk): number {
  switch (reason) {
    case "required-missing":
      return 1;
    case "dependency-of-required":
      return 0.9;
    case "risk-reduction":
      // proportional to the number of unproven sites this analysis could close
      return risk.criticalSites > 0 ? 0.6 : 0.1;
    case "uncertainty-reduction":
      return 0.3;
  }
  void analysis;
  return 0;
}

function unmetDependencies(analysis: Analysis, ctx: AnalysisContext): string[] {
  return analysis.dependencies.filter((dep) => !analysisByName(dep).satisfied(ctx));
}

/** Classifies why an outcome stopped where it did. See `Verdict`. */
function classifyVerdict(sufficient: boolean, risk: ResidualRisk, stopReason: string): Verdict {
  if (sufficient) return "SUFFICIENT";
  if (risk.factors.some((f) => f.kind === "runtime-static-disagreement")) return "CONFLICTING_EVIDENCE";
  if (stopReason.startsWith("required-analysis-unavailable")) {
    return "ANALYSIS_UNSUPPORTED";
  }
  if (!risk.acceptable) return "HIGH_RESIDUAL_RISK";
  return "INSUFFICIENT_EVIDENCE";
}

export class Planner {
  private measuredCosts = new Map<string, number>();
  readonly mode: PlannerMode;
  readonly budgetMs: number | null;
  readonly marginalValueFloor: number;
  readonly memory: PlannerMemory;
  readonly queryCache: QueryCache | null;
  private readonly maxIterations: number;

  constructor(options: number | PlannerOptions = {}) {
    const opts: PlannerOptions = typeof options === "number" ? { maxIterations: options } : options;
    this.maxIterations = opts.maxIterations ?? 12;
    this.mode = opts.mode ?? "adaptive";
    this.budgetMs = opts.budgetMs ?? null;
    this.marginalValueFloor = opts.marginalValueFloor ?? 0;
    this.memory = opts.memory ?? new PlannerMemory();
    this.queryCache = opts.queryCache ?? null;
  }

  /** Feed measured costs from earlier runs so later plans can use real numbers. */
  recordMeasuredCost(analysis: string, ms: number): void {
    this.measuredCosts.set(analysis, ms);
  }

  /** measured value of information, uncertainty-points per second */
  private valueOfInformation(expectation: Expectation, risk: ResidualRisk): number | null {
    if (expectation.observations === 0) return null;
    const du = expectation.expectedUncertaintyReduction ?? 0;
    const closed = expectation.expectedRiskClosure ?? 0;
    const riskValue = risk.criticalSites > 0 ? Math.min(1, closed / risk.criticalSites) : 0;
    const costMs = expectation.expectedCostMs;
    if (costMs === null || costMs <= 0) return null;
    return ((du + riskValue) / costMs) * 1000;
  }

  private candidates<T>(
    task: TaskDefinition<T>,
    ctx: AnalysisContext,
    risk: ResidualRisk,
    uncertainty: Uncertainty,
  ): Candidate[] {
    const out: Candidate[] = [];
    const consider = (analysis: Analysis, reason: Candidate["reason"]) => {
      if (analysis.satisfied(ctx)) return;
      if (out.some((c) => c.analysis === analysis.name)) return;
      const blocked = unmetDependencies(analysis, ctx);
      const expectation = this.memory.expected(task.type, analysis.name);
      const feasible = blocked.length === 0 && analysis.precondition(ctx);
      out.push({
        analysis: analysis.name,
        reason,
        soundness: analysis.soundness,
        predictedUtility: predictUtility(analysis, reason, risk),
        priorMeasuredCostMs: this.measuredCosts.get(analysis.name) ?? expectation.expectedCostMs,
        feasible,
        blockedBy: blocked.length > 0 ? blocked : analysis.precondition(ctx) ? [] : ["precondition"],
        expectation,
        valuePerSecond: this.valueOfInformation(expectation, risk),
        decision: feasible ? "deferred-lower-value" : "blocked",
      });
      for (const dep of blocked) consider(analysisByName(dep), "dependency-of-required");
    };

    for (const name of task.requiredAnalyses) consider(analysisByName(name), "required-missing");

    const requiredOutstanding = out.length > 0;
    if (!requiredOutstanding) {
      // Only after the required evidence exists do we consider optional work,
      // and only when uncertainty or risk actually justifies it.
      const justified =
        !risk.acceptable || uncertainty.value === null || uncertainty.value > task.threshold;
      if (justified) {
        for (const name of task.optionalAnalyses) {
          const analysis = analysisByName(name);
          const reason: Candidate["reason"] = !risk.acceptable ? "risk-reduction" : "uncertainty-reduction";
          consider(analysis, reason);
        }
      }
    }
    return out;
  }

  private select(candidates: Candidate[]): Candidate | null {
    const feasible = candidates.filter((c) => c.feasible);
    if (feasible.length === 0) return null;
    // Required analyses are not optional: they gate the answer, so they are
    // never subject to the value floor.
    const required = feasible.filter(
      (c) => c.reason === "required-missing" || c.reason === "dependency-of-required",
    );
    const pool = required.length > 0 ? required : feasible;
    if (required.length === 0 && this.mode === "required-only") return null;
    if (required.length === 0 && this.mode === "adaptive" && this.marginalValueFloor > 0) {
      // Measured options below the floor are refused; unmeasured ones are
      // explored once, because refusing them would freeze the memory table.
      const worth = pool.filter((c) => c.valuePerSecond === null || c.valuePerSecond >= this.marginalValueFloor);
      if (worth.length === 0) {
        for (const c of pool) c.decision = "not-worth-cost";
        return null;
      }
      return this.rank(worth);
    }
    return this.rank(pool);
  }

  /** Rank by measured value of information, falling back to the documented heuristic. */
  private rank(feasible: Candidate[]): Candidate | null {
    const measured = feasible.filter((c) => c.valuePerSecond !== null);
    if (this.mode === "adaptive" && measured.length > 0 && measured.length === feasible.length) {
      return measured.sort((a, b) =>
        b.valuePerSecond! !== a.valuePerSecond!
          ? b.valuePerSecond! - a.valuePerSecond!
          : a.analysis.localeCompare(b.analysis),
      )[0]!;
    }
    // Expected utility gain per measured cost. When no cost measurement exists
    // yet, cost is unknown; we rank those after known-cheap options of equal
    // utility rather than inventing a number.
    return feasible.sort((a, b) => {
      const scoreA = a.priorMeasuredCostMs ? a.predictedUtility / a.priorMeasuredCostMs : a.predictedUtility;
      const scoreB = b.priorMeasuredCostMs ? b.predictedUtility / b.priorMeasuredCostMs : b.predictedUtility;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.analysis.localeCompare(b.analysis);
    })[0]!;
  }

  async run<T>(task: TaskDefinition<T>, ctx: AnalysisContext, store: KnowledgeStore): Promise<PlanOutcome<T>> {
    const cacheFingerprint = `${ENGINE_FINGERPRINT}:${this.mode}:${this.budgetMs ?? "-"}:${this.marginalValueFloor}`;
    if (this.queryCache) {
      const cached = this.queryCache.get(task.type, task.target, store.revision, cacheFingerprint);
      if (cached) {
        return { ...(cached.outcome as PlanOutcome<T>), cacheHit: true };
      }
    }

    const outcome = await this.plan(task, ctx, store);
    if (this.queryCache) {
      this.queryCache.set(
        task.type,
        task.target,
        store.revision,
        outcome,
        outcome.totalCost.wallClockMs,
        cacheFingerprint,
      );
    }
    return outcome;
  }

  private async plan<T>(task: TaskDefinition<T>, ctx: AnalysisContext, store: KnowledgeStore): Promise<PlanOutcome<T>> {
    const steps: PlannerStep[] = [];
    const costs: CostRecord[] = [];
    let stopReason = "iteration-limit-reached";

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      let result = task.evaluate(store);
      let uncertainty = task.uncertainty(store, result);
      let risk = task.risk(store, result);

      const requiredMissing = task.requiredAnalyses.filter((n) => !analysisByName(n).satisfied(ctx));
      const sufficient =
        requiredMissing.length === 0 &&
        uncertainty.value !== null &&
        uncertainty.value <= task.threshold &&
        risk.criticalSites <= task.riskThreshold;

      if (sufficient && this.mode !== "exhaustive") {
        stopReason = "evidence-sufficient-and-residual-risk-acceptable";
        steps.push({
          iteration,
          candidates: [],
          selected: null,
          skipped: ANALYSES.filter((a) => !a.satisfied(ctx)).map((a) => a.name),
          predictedUtility: null,
          actualCost: null,
          uncertaintyBefore: uncertainty.value,
          uncertaintyAfter: uncertainty.value,
          actualUncertaintyReduction: 0,
          predictedUncertaintyReduction: null,
          predictedCostMs: null,
          predictionError: null,
          riskBefore: risk.criticalSites,
          riskAfter: risk.criticalSites,
          notes: ["stopping: further computation is not justified"],
          stopReason,
        });
        return this.finish(result, uncertainty, risk, steps, costs, stopReason, true);
      }

      const spentMs = sumCost(costs).wallClockMs;
      if (this.budgetMs !== null && spentMs >= this.budgetMs && requiredMissing.length === 0) {
        stopReason = `cost-budget-exhausted:${spentMs.toFixed(0)}ms>=${this.budgetMs}ms`;
        return this.finish(result, uncertainty, risk, steps, costs, stopReason, false);
      }

      const candidates = this.candidates(task, ctx, risk, uncertainty);
      const selected = this.select(candidates);
      if (!selected) {
        if (sufficient) stopReason = "evidence-sufficient-and-residual-risk-acceptable";
        // A blocked *required* candidate means the answer's evidence bar can
        // never be met (ANALYSIS_UNSUPPORTED is the right verdict). A blocked
        // *optional* candidate (e.g. IngestRuntimeTrace/IngestCoverage with no
        // trace/coverage file present — the common case) just means residual
        // uncertainty can't be reduced further with what's available; that is
        // ordinary INSUFFICIENT_EVIDENCE, not an unsupported required analysis.
        // Blurring the two previously made every query without a runtime
        // trace or coverage file report ANALYSIS_UNSUPPORTED even when every
        // required analysis had already run and risk was acceptable.
        const blockedRequired = candidates.some(
          (c) => c.reason === "required-missing" || c.reason === "dependency-of-required",
        );
        stopReason =
          candidates.length === 0
            ? requiredMissing.length === 0
              ? "no-further-analysis-can-reduce-uncertainty-or-risk"
              : "required-analysis-unavailable"
            : blockedRequired
              ? `required-analysis-unavailable:${candidates.map((c) => c.blockedBy.join("/")).join("|")}`
              : `optional-analysis-unavailable:${candidates.map((c) => c.blockedBy.join("/")).join("|")}`;
        steps.push({
          iteration,
          candidates,
          selected: null,
          skipped: candidates.map((c) => c.analysis),
          predictedUtility: null,
          actualCost: null,
          uncertaintyBefore: uncertainty.value,
          uncertaintyAfter: uncertainty.value,
          actualUncertaintyReduction: 0,
          predictedUncertaintyReduction: null,
          predictedCostMs: null,
          predictionError: null,
          riskBefore: risk.criticalSites,
          riskAfter: risk.criticalSites,
          notes: [
            risk.acceptable
              ? "residual risk acceptable"
              : `residual risk remains: ${risk.explanation} (no analysis available to close it)`,
          ],
          stopReason,
        });
        return this.finish(result, uncertainty, risk, steps, costs, stopReason, false);
      }

      const before = uncertainty.value;
      const riskBefore = risk.criticalSites;
      const analysis = analysisByName(selected.analysis);
      selected.decision = "selected";
      const outcome = await runAnalysis(analysis, ctx);
      costs.push(outcome.cost);
      this.recordMeasuredCost(analysis.name, outcome.cost.wallClockMs);

      result = task.evaluate(store);
      uncertainty = task.uncertainty(store, result);
      risk = task.risk(store, result);
      this.memory.observe(task.type, analysis.name, {
        uncertaintyReduction: before !== null && uncertainty.value !== null ? before - uncertainty.value : null,
        riskSitesClosed: riskBefore - risk.criticalSites,
        costMs: outcome.cost.wallClockMs,
      });

      steps.push({
        iteration,
        candidates,
        selected: selected.analysis,
        skipped: candidates.filter((c) => c.analysis !== selected.analysis).map((c) => c.analysis),
        predictedUtility: selected.predictedUtility,
        actualCost: outcome.cost,
        uncertaintyBefore: before,
        uncertaintyAfter: uncertainty.value,
        actualUncertaintyReduction:
          before !== null && uncertainty.value !== null ? before - uncertainty.value : null,
        predictedUncertaintyReduction: selected.expectation.expectedUncertaintyReduction,
        predictedCostMs: selected.expectation.expectedCostMs,
        predictionError:
          selected.expectation.expectedUncertaintyReduction !== null &&
          before !== null &&
          uncertainty.value !== null
            ? Math.abs(selected.expectation.expectedUncertaintyReduction - (before - uncertainty.value))
            : null,
        riskBefore,
        riskAfter: risk.criticalSites,
        notes: outcome.notes,
        stopReason: null,
      });
    }

    const result = task.evaluate(store);
    const uncertainty = task.uncertainty(store, result);
    const risk = task.risk(store, result);
    return this.finish(result, uncertainty, risk, steps, costs, stopReason, false);
  }

  private finish<T>(
    result: T,
    uncertainty: Uncertainty,
    risk: ResidualRisk,
    steps: PlannerStep[],
    costs: CostRecord[],
    stopReason: string,
    sufficient: boolean,
  ): PlanOutcome<T> {
    const errors = steps.map((s) => s.predictionError).filter((v): v is number => v !== null);
    const notRun = new Map<string, string>();
    for (const step of steps) {
      for (const candidate of step.candidates) {
        if (candidate.analysis === step.selected) continue;
        notRun.set(
          candidate.analysis,
          candidate.decision === "blocked"
            ? `blocked by ${candidate.blockedBy.join(", ")}`
            : candidate.decision === "not-worth-cost"
              ? `measured value ${candidate.valuePerSecond?.toFixed(4) ?? "unknown"}/s below floor`
              : "lower measured value of information than the selected analysis",
        );
      }
    }
    for (const step of steps) if (step.selected) notRun.delete(step.selected);
    return {
      result,
      uncertainty,
      risk,
      steps,
      totalCost: sumCost(costs),
      costByAnalysis: costs,
      stopReason,
      sufficient,
      mode: this.mode,
      calibration: {
        predictions: errors.length,
        meanAbsoluteError:
          errors.length === 0 ? null : errors.reduce((a, b) => a + b, 0) / errors.length,
      },
      notRun: [...notRun].map(([analysis, reason]) => ({ analysis, reason })),
      cacheHit: false,
      verdict: classifyVerdict(sufficient, risk, stopReason),
    };
  }
}
