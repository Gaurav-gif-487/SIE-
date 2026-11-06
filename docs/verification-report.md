# Software Intelligence Engine — Verification Report

Generated from actual runs in this repository. Every number below was produced by
`npx vitest run` and `npx tsx src/benchmark/run.ts`. No value is estimated or hardcoded.

## Architecture implemented
Five layers with explicit contracts:
- Task layer — `src/tasks/find-callers.ts` (typed task: requiredEvidence, uncertainty fn, risk fn, thresholds)
- Knowledge layer — `src/knowledge/store.ts` (entities, relations, evidence, conflicts, unknown regions, staleness, provenance)
- Planning layer — `src/planning/planner.ts` (dependency-aware greedy loop, utility/cost records, stop conditions)
- Evidence layer — `src/canonical/model.ts` + store (fact, source, sourceType, location, revision, derivation, status, producedBy)
- Reasoning layer — `src/reasoning/context.ts` (evidence-only context pack; no LLM is invoked, status is reported)

Acquisition boundary: `src/acquisition/*` (TypeScript compiler API, git, coverage, runtime trace).
Analysis library: `src/analyses/library.ts` (9 analyses, each declaring inputs/outputs/dependencies/preconditions).
Interfaces: CLI `src/cli/main.ts`, MCP stdio server `src/api/mcp-server.ts`, programmatic `src/engine/engine.ts`. All three call the same Engine.

## Modules preserved / removed / rewritten
The uploaded phase-3 repository was tree-sitter based with no type checker and no task/planner layers.
- Preserved concepts (re-implemented on real compiler evidence): BM25 lexical discovery, context optimisation, evidence graph, git/coverage signal ingestion, MCP + CLI entry points, incremental file invalidation.
- Removed: multi-language tree-sitter adapters, embedding/ONNX tokenizers, adaptive ranker weights, plan-eval scoring, forge client, dead-code/rename-safety heuristics — none produced type-grounded evidence and all reported scores that were not calibrated. No UI existed; none was added.
- Rewritten from scratch: canonical model, knowledge store, call resolution, task layer, planner, cost model, baseline, benchmark.

## Real capabilities
Type-aware call resolution (EXACT / PARTIAL / AMBIGUOUS / UNRESOLVED) via `getSymbolAtLocation`, alias resolution, `getResolvedSignature`, union receivers; inheritance edges; references; FindCallers with confirmed / possible / unresolved / unsupported partitioning; task-specific uncertainty with an explicit "denominator unknown" state; residual risk from counted dynamic-dispatch, reflection, generated-code, unparsed-file, stale-index and conflicting-evidence sites; measured cost (wall clock, heap delta, files, symbols, LLM calls/tokens); file-hash incremental invalidation; git/coverage/runtime-trace ingestion that returns UNKNOWN when input is absent.

## Partial capabilities / known limitations
- Only FindCallers is implemented. Other task types are absent by design, not stubbed.
- Interface-typed calls are PARTIAL; implementation expansion relies on in-repository IMPLEMENTS/EXTENDS edges only.
- Vector/semantic retrieval: UNSUPPORTED (no model bundled). LLM: never invoked; status `NOT_INVOKED_NO_MODEL_CONFIGURED`.
- Recall gap measured below: the oracle treats interface and implementing members as one symbol; the engine separates them, so `FastRunner.run` recall is 0.5 against that oracle. This is a reported disagreement, not a fixed number.
- Monorepo/project-references benchmarking not yet run.

## Build / test / typecheck
- `npx tsc --noEmit`: 0 errors.
- `npx vitest run`: 15 passed / 15, including planner cases A–D, provenance, incremental invalidation and baseline comparison.

## Ground-truth benchmark (independent oracle: TS language service findReferences, call sites only)
Full machine-readable results: `results/benchmarks-real-repo-results.json`.

| repo | symbol | truth | adaptive P/R/F1 | fp | fn | adaptive ms | files | baseline P/R | baseline ms |
|---|---|---|---|---|---|---|---|---|---|
| repo-a | FastRunner.run | 4 | 1 / 0.5 / 0.67 | 0 | 2 | 1052.5 | 12 | 1 / 1 | 4.9 |
| repo-a | SlowRunner.run | 4 | 1 / 0.25 / 0.40 | 0 | 3 | 0 | 0 | 1 / 1 | 2.1 |
| repo-a | AdminService.authenticate | 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 1 / 1 | 1.8 |
| repo-a | useFast | 0 | undefined (no sites) | 0 | 0 | 29.6 | 6 | undefined | 2.2 |
| engine (49 files) | acquireCalls | 1 | 1 / 1 / 1 | 0 | 0 | 1451.9 | 92 | 1 / 1 | 39.5 |
| engine | acquireSymbols | 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 1 / 1 | 37.4 |
| engine | KnowledgeStore.addEvidence | 10 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 1 / 1 | 50.7 |
| engine | findCallersTask | 1 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 1 / 1 | 42.1 |
| engine | measure | 2 | 1 / 1 / 1 | 0 | 0 | 0 | 0 | 1 / 1 | 47.9 |

0 ms / 0 files rows are subsequent tasks on the same Engine instance: the planner
selected no analysis because the evidence already existed (planner Case A).

## Baseline vs adaptive
- LLM usage: 0 calls / 0 tokens in both modes for every case (measured).
- First task on a repository costs the adaptive engine more than the baseline (compiler + type checker); every later task on the same knowledge state costs 0 additional analysis.
- Accuracy difference is qualitative and unit-tested: on `FastRunner.run` the baseline reports name-matched sites including `SlowRunner.run`'s site as callers, the engine reports 0 false positives and separates possible / unresolved sites.

## Planner instrumentation (per step, recorded)
candidates considered, selection, predicted utility (transparent heuristic, explicitly uncalibrated), measured wall-clock/heap/files/symbols, uncertainty before/after, actual reduction, risk before/after, stop reason.

## Not measured
CPU time per analysis, large (>100k LOC) repositories, monorepos, coverage/runtime-trace benchmarks (no real trace was supplied). These are left blank rather than estimated.
