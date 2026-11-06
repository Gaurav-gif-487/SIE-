# CallImpact: CALLS vs REFERENCES

## Question
Do the residual ky CallImpact false positives (`isRawNetworkError`, `delay`,
`timeout`) come from an engine bug, or from the benchmark asking a
call-semantics question of a reference-semantics mechanism?

## Method
Minimal controlled fixture `tests/fixtures/repo-ref`:
- `target.ts` — the target
- `caller.ts` — `target()` is **called**
- `indirect.ts` — calls `callsTarget()` (transitive call)
- `refonly.ts` — `target` stored in an array / `typeof target`; **never called**
- `unrelated.ts` — precision control

Two independently implemented oracles: existing `callImpactOracle`
(call/construct closure) and new `referenceImpactOracle` (mention closure).
Engine run twice, differing in exactly one variable (`includeReferences`).

## Result
| engine arm | vs callImpactOracle | vs referenceImpactOracle |
|---|---|---|
| calls+refs (default) | P 0.75 / R 1.00 / **F1 0.857** | **F1 1.000** |
| calls-only (new)     | **F1 1.000** | recall-limited by construction |

The lone false positive under call semantics is `refonly.ts`.

## Conclusion — PROVEN (fixture scale), OPEN (repo scale)
`impactOfChange` implements **reference/general impact** faithfully. The metric,
not the engine, was wrong. The benchmark should report three distinct tasks:
`CallImpact` (calls-only vs callImpactOracle), `ReferenceImpact` (default vs
referenceImpactOracle), `GeneralImpact` (union). Confirmation at ky/zod scale is
not yet run (script ready).

No ground truth was relaxed. Oracle changes (`src/experiment/oracles-ref.ts`)
and engine changes (`src/tasks/queries.ts`, `src/engine/engine.ts`) are in
disjoint files and separately labelled in-source.
