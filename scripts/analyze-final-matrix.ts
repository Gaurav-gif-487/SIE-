/**
 * Phases 7 & 9 aggregation: turns the raw decision-benchmark rows into the
 * per-category FindCallees table and the final three-arm matrix.
 *
 * Two scorings are reported side by side and both are shown everywhere:
 *   strict     — exact symbol-name match against the hand-written labels
 *   normalized — container prefix stripped from the engine's answer
 *                (`DerivedService.perform` -> `perform`) before matching.
 * The labels are NOT edited to accommodate the engine; the normalized column
 * exists so a naming-convention mismatch is not silently reported as a
 * resolution failure, and the gap between the two columns is itself the
 * measurement of how much of the "error" is cosmetic.
 */
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const p3 = JSON.parse(fs.readFileSync(path.join(ROOT, "results/raw/phase3-decision-benchmark.json"), "utf8"));
const OUTDIR = path.join(ROOT, "results/scores");
fs.mkdirSync(OUTDIR, { recursive: true });

const norm = (s: string) => (s.includes(".") ? s.slice(s.lastIndexOf(".") + 1) : s);
function prf(answer: string[], truth: string[]) {
  const A = new Set(answer);
  const T = new Set(truth);
  const tp = [...A].filter((x) => T.has(x)).length;
  const p = A.size ? tp / A.size : T.size ? 0 : 1;
  const r = T.size ? tp / T.size : 1;
  return { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
}

const scored = p3.rows.map((row: any) => {
  const strict = prf(row.answer, row.expected);
  // Container-prefix normalization is a *symbol-name* affordance only. Answers
  // that are file paths (CallImpact) must never be normalized: `src/a.ts` would
  // collapse to `ts` and every path would spuriously match every other.
  const normalized =
    row.phase === "phase3-findcallees"
      ? prf([...new Set(row.answer.map(norm))], row.expected.map(norm))
      : strict;
  return { ...row, strict, normalized };
});

fs.writeFileSync(path.join(OUTDIR, "decision-scores.json"), JSON.stringify({ generatedAt: new Date().toISOString(), rows: scored }, null, 2));

function table(rows: any[], header: string[], body: (string | number)[][]) {
  void rows;
  const line = (xs: (string | number)[]) => `| ${xs.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
}
const f = (n: number) => n.toFixed(3);

// ---- Phase 9: final matrix, per task, per arm ---------------------------
const tasks = [...new Set(scored.map((r: any) => r.task))] as string[];
const arms = ["required-only", "adaptive", "exhaustive"];
const matrix = table(
  scored,
  ["Task", "Class", "Arm", "F1 (strict)", "F1 (norm)", "P", "R", "Analyses", "Latency ms", "Verdict"],
  tasks.flatMap((t) =>
    arms.map((a) => {
      const r = scored.find((x: any) => x.task === t && x.arm === a)!;
      return [t, r.taskClass, a, f(r.strict.f1), f(r.normalized.f1), f(r.strict.precision), f(r.strict.recall), r.analysesRun, r.wallMs.toFixed(0), r.verdict];
    }),
  ),
);

// ---- arm-level aggregate -------------------------------------------------
const agg = table(
  scored,
  ["Arm", "Tasks", "Mean F1 (strict)", "Mean F1 (norm)", "Mean P", "Mean R", "Mean analyses", "Total analyses", "Total latency ms"],
  arms.map((a) => {
    const rs = scored.filter((r: any) => r.arm === a);
    const m = (sel: (r: any) => number) => rs.reduce((s: number, r: any) => s + sel(r), 0) / rs.length;
    return [
      a,
      rs.length,
      f(m((r) => r.strict.f1)),
      f(m((r) => r.normalized.f1)),
      f(m((r) => r.strict.precision)),
      f(m((r) => r.strict.recall)),
      m((r) => r.analysesRun).toFixed(2),
      rs.reduce((s: number, r: any) => s + r.analysesRun, 0),
      rs.reduce((s: number, r: any) => s + r.wallMs, 0).toFixed(0),
    ];
  }),
);

// ---- the critical experiment: per-task arm comparison --------------------
const CORRECT = 0.999;
const compare = tasks.map((t) => {
  const g = (a: string) => scored.find((x: any) => x.task === t && x.arm === a)!;
  const ro = g("required-only"), ad = g("adaptive"), ex = g("exhaustive");
  const ok = (r: any) => r.normalized.f1 >= CORRECT;
  let verdict: string;
  if (!ok(ro) && ok(ad) && ok(ex)) verdict = "RECOVERY (thesis-supporting)";
  else if (ok(ro) && ok(ad) && ok(ex)) verdict = "all-correct (cost question only)";
  else if (!ok(ro) && !ok(ad) && ok(ex)) verdict = "PLANNER FAILURE (exhaustive-only win)";
  else if (!ok(ro) && !ok(ad) && !ok(ex)) verdict = "all-wrong (engine limitation, not planner)";
  else if (ok(ro) && !ok(ad)) verdict = "ADAPTIVE REGRESSION";
  else verdict = "mixed";
  return { task: t, taskClass: ro.taskClass, verdict, roF1: ro.normalized.f1, adF1: ad.normalized.f1, exF1: ex.normalized.f1, roA: ro.analysesRun, adA: ad.analysesRun, exA: ex.analysesRun };
});
const critical = table(
  scored,
  ["Task", "Class", "required-only F1", "adaptive F1", "exhaustive F1", "req analyses", "adp analyses", "exh analyses", "Classification"],
  compare.map((c) => [c.task, c.taskClass, f(c.roF1), f(c.adF1), f(c.exF1), c.roA, c.adA, c.exA, c.verdict]),
);
const verdictCounts = compare.reduce((m: Record<string, number>, c) => ((m[c.verdict] = (m[c.verdict] ?? 0) + 1), m), {});

// ---- Phase 7: FindCallees per failure category ---------------------------
const fc = scored.filter((r: any) => r.phase === "phase3-findcallees" && r.arm === "adaptive");
const categories = table(
  fc,
  ["Category", "Task", "F1 (strict)", "F1 (norm)", "P", "R", "Missing", "Spurious", "Hedged (possible)", "Verdict"],
  fc.map((r: any) => [
    r.taskClass,
    r.symbol,
    f(r.strict.f1),
    f(r.normalized.f1),
    f(r.strict.precision),
    f(r.strict.recall),
    r.falseNegatives.join(" ") || "—",
    r.falsePositives.join(" ") || "—",
    r.hedged.join(" ") || "—",
    r.verdict,
  ]),
);

const md = `<!-- generated by scripts/analyze-final-matrix.ts; do not hand-edit -->
# Decision-needed benchmark — generated tables

Generated: ${new Date().toISOString()}
Source: results/raw/phase3-decision-benchmark.json (${scored.length} rows)

## Critical experiment (Phase 3)

${critical}

Classification counts: ${JSON.stringify(verdictCounts)}

## Arm aggregate

${agg}

## FindCallees by category (Phase 7, adaptive arm)

${categories}

## Full matrix (Phase 9)

${matrix}
`;
fs.writeFileSync(path.join(ROOT, "docs/experiments/GENERATED-TABLES.md"), md);
console.log(md);
console.log("classification counts:", verdictCounts);
