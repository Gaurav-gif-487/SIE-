# Software Intelligence Engine

Evidence-grounded static analysis for TypeScript/JavaScript (callers, callees, impact, tests-for, repo overview), with explicit uncertainty and a verification layer. No UI.

**Status: research prototype. Tested on Node 22** (uses `node:sqlite` when available, otherwise a JSON-file fallback).

> **Read this first.** The engine's adaptive, cost-aware planner is an experiment, and the experiment did not pan out. On the project's own benchmark, `adaptive` ran the same analyses as `exhaustive` and recovered no correctness that a minimal system missed. The hypothesis is recorded as **not supported** in [docs/experiments/HYPOTHESIS-VERDICT.md](docs/experiments/HYPOTHESIS-VERDICT.md), which also lists what *is* supported (identity-anchored oracles, calibrated "I don't know" answers, six of nine FindCallees categories resolved perfectly). The benchmark is one 9-class fixture with 17 tasks, so treat all numbers as small-sample.

    npx tsx src/cli/main.ts index <repo>
    npx tsx src/cli/main.ts refresh <repo>
    npx tsx src/cli/main.ts callers <repo> <symbol> [--json] [--coverage f] [--trace f]
    npx tsx src/cli/main.ts callees <repo> <symbol>
    npx tsx src/cli/main.ts references <repo> <symbol>
    npx tsx src/cli/main.ts impact <repo> <symbol> [--depth n]
    npx tsx src/cli/main.ts tests-for <repo> <symbol>
    npx tsx src/cli/main.ts why-changed <repo> <symbol>
    npx tsx src/cli/main.ts dependents <repo> <module>
    npx tsx src/cli/main.ts overview <repo> [--budget n]
    npx tsx src/cli/main.ts analyze <repo> --task "FindCallers(authenticate)"
    npx tsx src/cli/main.ts context <repo> --task "FindCallers(authenticate)"
    npx tsx src/cli/main.ts export-scip <repo> --out index.scip
    npx tsx src/cli/main.ts search <repo> <query>
    npx tsx src/cli/main.ts baseline <repo> <symbol>     # conventional pipeline, for comparison

MCP (stdio, full task set — 13 tools, warm engine cache across calls): `npx tsx src/api/mcp-server.ts`.
Tests: `npx vitest run`. Benchmark: `npx tsx src/benchmark/run.ts`.
Verification benchmark: `npx tsx src/benchmark/verification-benchmark.ts`.
See `docs/verification-report.md` for measured results and limitations, and
`docs/verification-layer.md` for the challenge/verification mechanism.

## Query cache & verification

Pass `queryCache: new QueryCache()` (`src/planning/query-cache.ts`) to
`Engine` to reuse whole answered queries across calls when the repository
revision hasn't moved, instead of only reusing per-analysis cost/uncertainty
statistics (`PlannerMemory`). It composes with the on-disk persistence below:
persistence survives across process invocations; the query cache also skips
re-running the planner loop entirely within a warm process (daemon, MCP
server) when nothing has changed.

`Engine.findCallers`/`findCallees` independently challenge their own
conclusions when a deterministic policy says the risk warrants it (via
`verification` in `EngineOptions`, or a per-call override) — see
`docs/verification-layer.md` for the mechanism.

## Persistence & daemon

Facts and planner-memory observations persist to disk (SQLite via Node's
built-in `node:sqlite`, no extra dependency; falls back to a JSON file on
Node versions without it), keyed per repository under `~/.sie-cache`
(override with `SIE_CACHE_DIR`). A repeat query against an unchanged file is
now a cache hit, not a recompute — every `Engine` invocation, CLI or MCP,
gets this automatically.

For CLI usage across many invocations in a session, a background daemon
keeps `Engine` instances warm in memory (no per-invocation `ts.Program`
rebuild at all, not even a disk hit):

    npx tsx src/cli/main.ts daemon start
    npx tsx src/cli/main.ts daemon status
    npx tsx src/cli/main.ts daemon stop

Every command works identically with or without the daemon running — it's
a pure speed optimization, not a requirement. See `src/daemon/`.

## SCIP export

`export-scip` (CLI) and `export_scip` (MCP) emit a best-effort [SCIP](https://github.com/sourcegraph/scip)
index of currently-known symbols and occurrences, for interop with
SCIP-consuming tooling. This is a hand-rolled protobuf encoder (see
`src/scip/`, no dependency) covering `Metadata`/`Document`/`Occurrence`/
`SymbolInformation`; it is not a certified SCIP indexer and symbol strings
are stable within one export but not guaranteed to match an official
TypeScript SCIP indexer.

## RepoOverview: the first-contact task

Every targeted task (`FindCallers`, `ImpactOfChange`, `ModuleDependents`,
...) requires the caller to already know which symbol or module to ask
about. `overview` (CLI) / `repo_overview` (MCP) / `Engine.repoOverview()`
(SDK) doesn't: it returns a compressed, evidence-backed structural summary
— crystallization level, file/module/symbol totals, unknown regions by
kind, and modules ranked by fan-in (`coreModules`, the parts of the repo
most depended-upon) and by zero fan-in (`leafModules`, likely entry points
or scripts) — trimmed to a token budget (`--budget`, default 2000) using
the same greedy budget-trimming pattern as `context.ts`'s FindCallers
context packs. It's the primitive an agent runs before it knows what to
ask about next; it never triggers analysis deeper than the cheapest level
(files/modules/imports) on its own.

## TypeScript SDK

`src/index.ts` is the deliberate public surface for programmatic use —
`Engine`, task result types, verification types, `VerifiedPlanOutcome`,
`repoOverview`/`RepoOverviewResult`, `crystallizationLevel`/
`CrystallizationReport`, and `exportScip` — as opposed to importing
internal modules directly. This package ships as TypeScript source (no
separate `dist/` build), so a consumer runs it with `tsx`/`ts-node` or
their own build step, importing the same code the CLI, daemon, and MCP
server run:

    import { Engine } from "software-intelligence-engine";

    const engine = new Engine("/path/to/repo");
    const callers = await engine.findCallers("MyClass.myMethod");
    const overview = await engine.repoOverview(1500);
    engine.close();

This is one of the four interfaces this project targets (CLI, MCP server,
TypeScript SDK, plugin interface via `TaskDefinition`/`Analysis`); see
`src/index.ts` itself for the full exported surface.



## Real-repository experiments

The experiments in `src/experiment/` run against third-party repositories that are not vendored here. Fetch them first:

```bash
./scripts/fetch-corpus.sh                  # clones ky and zod into corpus/ at pinned tags
npx tsx src/experiment/gt.ts               # regenerate ground truth
npx tsx src/experiment/runner.ts           # run all arms (resumable)
```

Findings are in `docs/experiments/`. The ky numbers were produced against a ky snapshot that differs slightly from the pinned `v2.0.2` tag, so a fresh run can differ by a few lines of location data.
