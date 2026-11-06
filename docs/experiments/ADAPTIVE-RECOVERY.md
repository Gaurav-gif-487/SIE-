# Adaptive Recovery — Phases 3–7 (negative result)

Generated from `results/raw/phase3-decision-benchmark.json`,
`results/raw/phase4-uncertainty-value.json`,
`results/raw/phase6-verification-ablation.json`.
Numeric tables: `GENERATED-TABLES.md`. Scores: `results/scores/decision-scores.json`.

## What was tested

Benchmark: `tests/fixtures/repo-decision`, 9 task classes (direct-call, alias,
re-export+alias+inheritance, callback, higher-order function, constructor,
dynamic dispatch, reference-only, unresolvable), ground truth hand-written in
`tests/groundtruth/repo-decision.labels.json` independently of engine output.
17 tasks (9 FindCallees + 8 CallImpact) x 3 arms = 51 runs, cold cache each.

Arms: `required-only` (run only analyses the task declares required),
`adaptive` (planner decides), `exhaustive` (run everything available).

## Headline result — the hypothesis is NOT supported

| Arm | Mean F1 | Mean P | Mean R | Total analyses | Total latency |
| --- | --- | --- | --- | --- | --- |
| required-only | 0.847 | 0.912 | 0.814 | 91 | 11266 ms |
| adaptive | 0.847 | 0.912 | 0.814 | 107 | 10838 ms |
| exhaustive | 0.847 | 0.912 | 0.814 | 107 | 10963 ms |

Per-task classification over all 17 tasks:

- **RECOVERY (adaptive right where required-only is wrong): 0 tasks.**
- all three arms correct: 12 tasks (a cost question only).
- all three arms wrong: 5 tasks (`FindCallees:entryHof`, `FindCallees:entryDynamic`,
  `CallImpact:targetCtor`, `CallImpact:targetDispatchA`, `CallImpact:targetCallback`).
- adaptive regressions: 0.

`adaptive` selected exactly the same analysis set as `exhaustive` on every one
of the 17 tasks (107 = 107 analyses, task-by-task identical), and never
produced an answer that differed from `required-only`. On this benchmark
adaptive is therefore not a middle point between the two arms: it is
**exhaustive's cost with required-only's accuracy**. The ~4% latency edge over
exhaustive is within run-to-run noise, not a saving.

Where the arms differ in *work* (`entryHof`, `entryDynamic`,
`entryReferenceOnly`, `entryUnresolvable`, and the four 8-analysis CallImpact
tasks), the extra analyses adaptive bought changed **no** answer. That is the
core negative finding: the extra computation was spent, and it was not
converted into recovered correctness.

## Phase 4 — does the planner's uncertainty predict marginal value?

Cold arms (the 51 runs above): 1059 candidate evaluations, of which
**0 had a `valuePerSecond` estimate and 0 had a prior measured cost.**
`PlannerMemory` is constructed empty per engine, so on a cold single-task run
the value-of-information term is undefined by construction and the planner
falls back to static reasons. The reason histogram confirms this: 765
`required-missing`, 149 `risk-reduction`, 107 `uncertainty-reduction`, 18
`dependency-of-required`. 76 of 85 steps did record `uncertaintyBefore`, so the
uncertainty signal exists; it just never meets a cost estimate.

Warming probe (`scripts/phase4-uncertainty-value.ts`, Part B): one shared
`PlannerMemory` across 3 rounds x 9 tasks. From round 0 onward the estimates
become populated (15–16 informed candidates per run), and the result is:

- mean analyses per task: 5.44 in round 0, 5.44 in round 1, 5.44 in round 2 — unchanged.
- every answer identical to round 0.
- `not-worth-cost` decisions across all 27 runs: **zero**.

So the value-of-information machinery computes, but with real measured costs in
hand it never once declines an analysis or changes a plan. Uncertainty is
recorded, not acted on. This is the mechanical explanation for the headline
result, and it is a planner/utility-calibration failure, not a plumbing bug —
the numbers reach the decision point and lose to the static `required-missing`
and `risk-reduction` reasons every time.

## Phase 5 — planner refinement: deliberately not attempted

No utility re-tuning was performed. Tuning thresholds against the same 17-task
suite used to measure the hypothesis would produce a number that cannot be
distinguished from fitting the benchmark. The honest prerequisite is a task
where extra analysis *demonstrably* changes the answer; Phase 3 found none
(all 5 failures are engine resolution limits that exhaustive also fails), so
there is currently nothing for a better planner to recover. Fixing the resolver
must precede tuning the planner.

## Phase 6 — verification / challenge ablation

Verification fires exactly where it should and does not improve correctness:

- It stays `not-required` on all clean tasks (no wasted challenge).
- It flags `entryHof` and `entryUnresolvable` as uncertain — correctly — but the
  final answers are unchanged, so its value here is calibration signalling, not
  accuracy.
- On `entryDynamic`, asserting the hedged set (`confirmed+possible`) *lowers*
  F1 from 0.800 to 0.500: the hedges are over-specific
  (`AlphaHandler.handleEvent`, `BetaHandler.handleEvent`, `Handler.handleEvent`)
  where the truth is the single interface method `handleEvent`.
- When it runs it adds latency.

Verdict: the verification layer is a working *honesty* mechanism (it refuses to
claim resolution it cannot support) and not an *accuracy* mechanism.

## Phase 7 — FindCallees by category

Full table in `GENERATED-TABLES.md`. Categories at F1 1.000:
direct-call, alias, callback, constructor, reference-only, unresolvable —
including the two "correct silence" cases where the right answer is the empty
set and the engine returns it with an appropriately non-SUFFICIENT verdict.

Two genuine failures:

- **higher-order-function (`entryHof`, F1 0.000)** — a function passed as a value
  and invoked through the parameter is never attributed to its declaration.
  `AnalyzeInheritance` and `ResolveCalls` both ran; neither models value flow of
  function references, so no amount of extra analysis reaches `targetHof`.
- **dynamic-dispatch (`entryDynamic`, F1 0.800)** — implementations are found
  (`AlphaHandler`, `BetaHandler`) but the interface method `handleEvent` is not
  reported as the callee; the qualified per-class hedges are the wrong
  granularity.

One scoring caveat, reported rather than hidden: on `entryHard` the engine
answers `DerivedService.perform` where the label says `perform`. Strict
name-matching scores that 0.500; container-prefix normalization scores it
1.000. The labels were **not** edited. Both columns appear in every generated
table, and the normalized column is the one used for the recovery
classification, because a naming-convention difference is not a resolution
failure. Path-valued CallImpact answers are never normalized.

## Phase 8 — unseen / multi-language repos: NOT RUN

No unseen-repo or cross-language generalization run was executed in this phase.
Nothing in this report should be read as a generalization claim. The measured
scope is one purpose-built 9-class TypeScript fixture.
