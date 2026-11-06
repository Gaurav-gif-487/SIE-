import fs from "node:fs";

/**
 * Planner memory: the observation table that turns the planner from a fixed
 * heuristic into a decision system.
 *
 * For every (taskType, analysis) pair the planner records what actually
 * happened when it ran that analysis: how much measured uncertainty it removed,
 * how many unproven sites it closed, and how many milliseconds it cost. Later
 * decisions use those measured means instead of invented constants, and every
 * estimate carries its observation count so an unmeasured option is never
 * presented as a known quantity.
 */

export interface Observation {
  uncertaintyReduction: number | null;
  riskSitesClosed: number;
  costMs: number;
}

export interface Expectation {
  /** mean measured uncertainty reduction, null when never observed */
  expectedUncertaintyReduction: number | null;
  /** mean measured number of unproven sites closed, null when never observed */
  expectedRiskClosure: number | null;
  /** mean measured wall-clock cost, null when never observed */
  expectedCostMs: number | null;
  observations: number;
}

const EMPTY: Expectation = {
  expectedUncertaintyReduction: null,
  expectedRiskClosure: null,
  expectedCostMs: null,
  observations: 0,
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export class PlannerMemory {
  private table = new Map<string, Observation[]>();

  private key(taskType: string, analysis: string): string {
    return `${taskType}::${analysis}`;
  }

  observe(taskType: string, analysis: string, observation: Observation): void {
    const key = this.key(taskType, analysis);
    const list = this.table.get(key) ?? [];
    list.push(observation);
    this.table.set(key, list);
  }

  expected(taskType: string, analysis: string): Expectation {
    const own = this.table.get(this.key(taskType, analysis)) ?? [];
    // Fall back to observations of the same analysis under other task types:
    // cost transfers across tasks, effect on uncertainty does not, so only the
    // cost estimate is borrowed.
    const crossTask: Observation[] = [];
    if (own.length === 0) {
      for (const [key, list] of this.table) {
        if (key.endsWith(`::${analysis}`)) crossTask.push(...list);
      }
    }
    const source = own.length > 0 ? own : [];
    if (source.length === 0 && crossTask.length === 0) return EMPTY;
    return {
      expectedUncertaintyReduction: mean(
        source.map((o) => o.uncertaintyReduction).filter((v): v is number => v !== null),
      ),
      expectedRiskClosure: mean(source.map((o) => o.riskSitesClosed)),
      expectedCostMs: mean((source.length > 0 ? source : crossTask).map((o) => o.costMs)),
      observations: source.length,
    };
  }

  snapshot(): Record<string, Expectation> {
    const out: Record<string, Expectation> = {};
    for (const key of this.table.keys()) {
      const [taskType, analysis] = key.split("::") as [string, string];
      out[key] = this.expected(taskType, analysis);
    }
    return out;
  }

  save(file: string): void {
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(this.table), null, 2));
  }

  static load(file: string): PlannerMemory {
    const memory = new PlannerMemory();
    if (!fs.existsSync(file)) return memory;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Observation[]>;
    for (const [key, list] of Object.entries(raw)) memory.table.set(key, list);
    return memory;
  }
}
