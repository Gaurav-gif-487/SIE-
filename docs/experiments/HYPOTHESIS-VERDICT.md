# SIE — Hypothesis Verdict (Phase 9 / 10)

## The hypothesis

> A software-intelligence runtime can dynamically determine when additional
> analysis is worth its computational cost, perform that additional analysis
> only when necessary, and recover correctness that a minimum-computation
> system would otherwise miss.

## Verdict: NOT SUPPORTED by the evidence collected.

The hypothesis has three clauses. On the evidence in this repository:

| Clause | Verdict | Evidence |
| --- | --- | --- |
| determine when additional analysis is worth its cost | **Not demonstrated** | 0 of 1059 cold candidate evaluations had a cost-vs-value estimate; with a warmed memory the estimates exist but produced 0 `not-worth-cost` decisions across 27 runs and changed no plan |
| perform additional analysis only when necessary | **Contradicted** | `adaptive` ran the identical analysis set to `exhaustive` on all 17 tasks (107 vs 107), and 16 more analyses than `required-only`, for zero answer changes |
| recover correctness a minimal system misses | **Contradicted** | 0 recovery cases in 17 tasks; all three arms score mean F1 0.847 / P 0.912 / R 0.814 |

The falsifying observation is clean and does not depend on scoring choices:
**on this benchmark, all three arms produce the same answers.** Adaptivity
changed cost and changed nothing else.

## What *is* supported

These are the claims the evidence does carry, stated no wider than the data:

1. **Identity-anchored oracles are necessary and now correct.** Under
   name-collision stress (`tests/fixtures/repo-collide`) the name-keyed oracle
   merged unrelated impact closures on 7/7 cases; the declaration-anchored
   oracle in `src/experiment/oracles-identity.ts` separated 7/7. Any earlier
   accuracy number computed against name-keyed ground truth is unreliable.
2. **The engine is honest about what it does not know.** Verification stays
   silent on clean tasks, fires on exactly the two genuinely uncertain ones, and
   the engine returns the empty set with a non-SUFFICIENT verdict on
   reference-only and unresolvable tasks instead of inventing callees.
   Calibration works even where accuracy does not improve.
3. **Six of nine FindCallees categories resolve perfectly** (direct-call, alias,
   callback, constructor, reference-only, unresolvable).

## Why it failed — mechanism, not excuse

Two independent causes, both measured:

- **Planner:** value-of-information is computed but never decisive. Cold runs
  have no cost history at all; warmed runs have it and still never decline an
  analysis. Static `required-missing` / `risk-reduction` reasons dominate every
  selection, which makes `adaptive` degenerate into `exhaustive`.
- **Resolver:** the 5 failing tasks fail in *all* arms. Higher-order function
  value flow is not modelled at all (F1 0.000), and dynamic dispatch reports
  implementations at the wrong granularity. There is currently **no task in the
  suite where more analysis would have produced a better answer** — so even a
  perfectly calibrated planner would have had nothing to recover.

That ordering matters for anyone continuing this work: tuning the planner
before fixing value-flow resolution would optimise a policy over an empty
opportunity set, and any gain would be benchmark fitting.

## Scope and threats to validity

- One purpose-built 9-class TypeScript fixture, 17 tasks. Small.
- Phase 8 (unseen repos, multi-language) was **not run**. No generalization
  claim is made.
- Phase 5 (planner refinement) was deliberately **not attempted** — see above.
- Ground truth is hand-written and independent of engine output, and was not
  edited when the engine disagreed. Where a disagreement was cosmetic
  (`DerivedService.perform` vs `perform`) both strict and normalized scores are
  reported side by side rather than one being chosen quietly.
- Latency figures are single-run, cold-cache, on a shared machine; differences
  under ~10% should be treated as noise.

## Honest one-line status

SIE is a working, well-calibrated analysis engine with an adaptive planner that
does not yet earn its name: it currently spends exhaustive cost for
minimum-computation accuracy, and the benchmark contains no case where its
extra work pays off.

## Reproduce

```
npm install
npx tsc --noEmit && npx vitest run                  # all tests pass (119 at time of writing)
npx tsx scripts/phase13-collision-stress.ts         # identity oracle, 7/7
npx tsx scripts/phase3-decision-benchmark.ts        # the 51 runs
npx tsx scripts/phase4-uncertainty-value.ts         # VOI + memory warming
npx tsx scripts/phase6-verification-ablation.ts     # verification ablation
npx tsx scripts/analyze-final-matrix.ts             # regenerates GENERATED-TABLES.md
```
