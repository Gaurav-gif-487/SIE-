#!/usr/bin/env node
import { Command } from "commander";
import { Engine, EngineOptions } from "../engine/engine.js";
import { buildFindCallersContext } from "../reasoning/context.js";
import { runBaselineFindCallers } from "../baseline/baseline.js";
import { formatLocation } from "../canonical/model.js";
import { Bm25Index, search } from "../search/search.js";
import { listSourceFiles } from "../acquisition/program.js";
import { callDaemon, daemonStatus, isDaemonRunning, startDaemon, stopDaemon } from "../daemon/client.js";
import { exportScip, writeScipFile } from "../scip/export.js";

/**
 * Run an Engine method, preferring a warm daemon (see src/daemon) when one
 * is reachable so repeat invocations against the same repository skip the
 * cold `ts.Program` rebuild. Falls back to an in-process Engine — every
 * command works identically with or without a daemon running.
 */
async function runEngineMethod<T>(
  repo: string,
  engineOptions: EngineOptions,
  method: string,
  args: unknown[],
): Promise<T> {
  if (await isDaemonRunning()) {
    try {
      return (await callDaemon(repo, method, args, engineOptions as Record<string, unknown>)) as T;
    } catch {
      // fall through to a local Engine if the daemon call itself fails
    }
  }
  const engine = new Engine(repo, engineOptions);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (engine as any)[method];
  const result = (await fn.apply(engine, args)) as T;
  engine.close();
  return result;
}

const program = new Command();
program.name("software-intelligence").description("Evidence-grounded software intelligence engine (TypeScript backend)");

const daemon = program.command("daemon").description("manage the background daemon that keeps repositories warm across invocations");
daemon
  .command("start")
  .description("start the daemon in the background, if not already running")
  .action(async () => {
    await startDaemon();
    console.log("daemon started");
  });
daemon
  .command("stop")
  .description("stop the daemon")
  .action(async () => {
    const ok = await stopDaemon();
    console.log(ok ? "daemon stopped" : "daemon was not running");
  });
daemon
  .command("status")
  .description("check whether the daemon is running and how many repositories it holds warm")
  .action(async () => {
    const status = await daemonStatus();
    console.log(status ? `running, warmRepos=${status.warmRepos ?? 0}` : "not running");
  });

program
  .command("index")
  .argument("<repo>")
  .option("--json", "emit JSON")
  .description("cheapest crystallization level: files and modules only")
  .action(async (repo: string, opts: { json?: boolean }) => {
    const engine = new Engine(repo);
    const res = await engine.index();
    const payload = { ...res, revision: engine.store.revision, revisionSource: engine.revisionSource };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else
      console.log(
        `files=${res.files} modules=${res.modules} revision=${engine.store.revision} (${engine.revisionSource}) measuredMs=${res.costMs.toFixed(1)}`,
      );
  });

program
  .command("index-python")
  .argument("<repo>")
  .option("--json", "emit JSON")
  .description("index .py files: files, modules, functions/methods/classes, name-based call edges (see src/acquisition/python.ts)")
  .action(async (repo: string, opts: { json?: boolean }) => {
    const engine = new Engine(repo);
    const res = await engine.indexPython();
    const payload = { ...res, revision: engine.store.revision };
    engine.close();
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else
      console.log(
        `pyFiles=${res.files} pyModules=${res.modules} functions=${res.functions} methods=${res.methods} classes=${res.classes} callSites=${res.callSites} parseErrors=${res.parseErrors} measuredMs=${res.costMs.toFixed(1)}`,
      );
  });

program
  .command("callers")
  .argument("<repo>")
  .argument("<symbol>")
  .option("--json", "emit JSON")
  .option("--coverage <path>", "istanbul coverage-final.json from a real test run")
  .option("--trace <path>", "runtime call trace JSON from an instrumented run")
  .description("FindCallers(symbol) via the adaptive planner")
  .action(async (repo: string, symbol: string, opts: { json?: boolean; coverage?: string; trace?: string }) => {
    const engineOptions = { coveragePath: opts.coverage ?? null, tracePath: opts.trace ?? null };
    const outcome = await runEngineMethod<Awaited<ReturnType<Engine["findCallers"]>>>(
      repo,
      engineOptions,
      "findCallers",
      [symbol],
    );
    if (opts.json) {
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }
    const r = outcome.result;
    console.log(`FindCallers(${symbol})  targetSelection=${r.targetSelectionStatus}`);
    for (const t of r.targets) console.log(`  target: ${t.container ? `${t.container}.` : ""}${t.name} @ ${formatLocation(t.location)}`);
    console.log(`confirmed callers (${r.confirmed.length}):`);
    for (const c of r.confirmed) console.log(`  ${formatLocation(c.callSite)}  ${c.callerName} -> ${c.calleeText}`);
    console.log(`possible callers (${r.possible.length}):`);
    for (const c of r.possible)
      console.log(`  ${formatLocation(c.callSite)}  ${c.callerName} -> ${c.calleeText} [${c.resolution}${c.receiverType ? `, receiver ${c.receiverType}` : ""}]`);
    console.log(`unresolved call sites (${r.unresolvedSites.length}):`);
    for (const c of r.unresolvedSites) console.log(`  ${formatLocation(c.callSite)}  ${c.calleeText} [${c.risk ?? "no static target"}]`);
    console.log(
      `uncertainty=${outcome.uncertainty.value === null ? "UNQUANTIFIED" : outcome.uncertainty.value.toFixed(4)}  (${outcome.uncertainty.explanation})`,
    );
    console.log(`residualRisk criticalSites=${outcome.risk.criticalSites} acceptable=${outcome.risk.acceptable} (${outcome.risk.explanation})`);
    console.log(`stopReason=${outcome.stopReason} sufficient=${outcome.sufficient} verdict=${outcome.verdict}`);
    console.log(
      `verification=${outcome.verification.decision.level} (${outcome.verification.decision.reasons.join("; ")})`,
    );
    if (outcome.verification.ran) {
      const c = outcome.verification.comparison;
      console.log(
        `  challenge=${outcome.verification.challenge?.method ?? "n/a"} costMs=${outcome.verification.challenge?.costMs.toFixed(1)} comparison=${c?.outcome ?? "UNAVAILABLE"}${c ? ` (agreed=${c.agreedCount} onlyInPrimary=${c.onlyInPrimary.length} onlyInChallenge=${c.onlyInChallenge.length})` : ""}`,
      );
    }
    console.log(`finalStatus=${outcome.finalStatus}`);
    console.log(
      `measured cost: ${outcome.totalCost.wallClockMs.toFixed(1)}ms heapDelta=${(outcome.totalCost.heapUsedDeltaBytes / 1048576).toFixed(1)}MB files=${outcome.totalCost.filesProcessed} symbols=${outcome.totalCost.symbolsProcessed} llmCalls=${outcome.totalCost.llmCalls}`,
    );
    for (const step of outcome.steps)
      console.log(
        `  step ${step.iteration}: selected=${step.selected ?? "<none>"} predictedUtility=${step.predictedUtility ?? "n/a"} actualMs=${step.actualCost ? step.actualCost.wallClockMs.toFixed(1) : "n/a"} uncertainty ${step.uncertaintyBefore ?? "UNQUANTIFIED"} -> ${step.uncertaintyAfter ?? "UNQUANTIFIED"} risk ${step.riskBefore} -> ${step.riskAfter}`,
      );
  });

program
  .command("python-callers")
  .argument("<repo>")
  .argument("<symbol>")
  .option("--json", "emit JSON")
  .description("FindPythonCallers(symbol): name-based call resolution over .py files (no type checker; see src/acquisition/python.ts)")
  .action(async (repo: string, symbol: string, opts: { json?: boolean }) => {
    const outcome = await runEngineMethod<Awaited<ReturnType<Engine["findPythonCallers"]>>>(
      repo,
      {},
      "findPythonCallers",
      [symbol],
    );
    if (opts.json) {
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }
    const r = outcome.result;
    console.log(`FindPythonCallers(${symbol})  targetSelection=${r.targetSelectionStatus}`);
    for (const t of r.targets) console.log(`  target: ${t.container ? `${t.container}.` : ""}${t.name} @ ${formatLocation(t.location)}`);
    console.log(`possible callers (${r.possible.length}):`);
    for (const c of r.possible) console.log(`  ${formatLocation(c.callSite)}  ${c.callerName} -> ${c.calleeText}`);
    console.log(`ambiguous callers (${r.ambiguous.length}):`);
    for (const c of r.ambiguous)
      console.log(`  ${formatLocation(c.callSite)}  ${c.callerName} -> ${c.calleeText} [${c.candidateCount} candidates]`);
    console.log(`unresolved call sites (${r.unresolvedSites.length}):`);
    for (const c of r.unresolvedSites) console.log(`  ${formatLocation(c.callSite)}  ${c.calleeText}`);
    console.log(
      `uncertainty=${outcome.uncertainty.value === null ? "UNQUANTIFIED" : outcome.uncertainty.value.toFixed(4)}  (${outcome.uncertainty.explanation})`,
    );
    console.log(`residualRisk criticalSites=${outcome.risk.criticalSites} acceptable=${outcome.risk.acceptable} (${outcome.risk.explanation})`);
    console.log(`stopReason=${outcome.stopReason} sufficient=${outcome.sufficient} verdict=${outcome.verdict}`);
    console.log(
      `measured cost: ${outcome.totalCost.wallClockMs.toFixed(1)}ms files=${outcome.totalCost.filesProcessed} symbols=${outcome.totalCost.symbolsProcessed}`,
    );
  });

program
  .command("analyze")
  .argument("<repo>")
  .requiredOption("--task <task>", 'e.g. "FindCallers(authenticate)"')
  .option("--json", "emit JSON")
  .description("run a typed task through the planner")
  .action(async (repo: string, opts: { task: string; json?: boolean }) => {
    const match = /^FindCallers\((.+)\)$/.exec(opts.task.trim());
    if (!match) {
      console.error(`UNSUPPORTED task: ${opts.task}. Implemented tasks: FindCallers(<symbol>)`);
      process.exitCode = 2;
      return;
    }
    const outcome = await runEngineMethod<Awaited<ReturnType<Engine["findCallers"]>>>(
      repo,
      {},
      "findCallers",
      [match[1]!],
    );
    console.log(
      opts.json
        ? JSON.stringify(outcome, null, 2)
        : JSON.stringify(
            {
              task: opts.task,
              confirmed: outcome.result.confirmed.length,
              possible: outcome.result.possible.length,
              unresolvedSites: outcome.result.unresolvedSites.length,
              uncertainty: outcome.uncertainty.value,
              residualRiskCriticalSites: outcome.risk.criticalSites,
              stopReason: outcome.stopReason,
              measuredMs: outcome.totalCost.wallClockMs,
            },
            null,
            2,
          ),
    );
  });

program
  .command("context")
  .argument("<repo>")
  .requiredOption("--task <task>", 'e.g. "FindCallers(authenticate)"')
  .option("--budget <tokens>", "token budget", "2000")
  .description("build the smallest useful evidence-backed context for an LLM")
  .action(async (repo: string, opts: { task: string; budget: string }) => {
    const match = /^FindCallers\((.+)\)$/.exec(opts.task.trim());
    if (!match) {
      console.error(`UNSUPPORTED task: ${opts.task}`);
      process.exitCode = 2;
      return;
    }
    const engine = new Engine(repo);
    const outcome = await engine.findCallers(match[1]!);
    const pack = buildFindCallersContext(engine.store, outcome.result, outcome.uncertainty, outcome.risk, {
      tokenBudget: Number(opts.budget),
    });
    console.log(JSON.stringify(pack, null, 2));
  });

program
  .command("refresh")
  .argument("<repo>")
  .description("invalidate any files whose content hash has changed since they were last analyzed")
  .action(async (repo: string) => {
    const res = await runEngineMethod<{ stale: string[]; invalidated: number }>(repo, {}, "refresh", []);
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command("callees")
  .argument("<repo>")
  .argument("<symbol>")
  .option("--json", "emit JSON")
  .description("FindCallees(symbol): what this symbol calls")
  .action(async (repo: string, symbol: string, opts: { json?: boolean }) => {
    const outcome = await runEngineMethod<Awaited<ReturnType<Engine["findCallees"]>>>(
      repo,
      {},
      "findCallees",
      [symbol],
    );
    console.log(JSON.stringify(outcome, null, 2));
    void opts;
  });

program
  .command("references")
  .argument("<repo>")
  .argument("<symbol>")
  .description("FindReferences(symbol): every reference, call or not")
  .action(async (repo: string, symbol: string) => {
    const outcome = await runEngineMethod<Awaited<ReturnType<Engine["findReferences"]>>>(
      repo,
      {},
      "findReferences",
      [symbol],
    );
    console.log(JSON.stringify(outcome, null, 2));
  });

program
  .command("impact")
  .argument("<repo>")
  .argument("<symbol>")
  .option("--depth <n>", "max traversal depth", "4")
  .description("ImpactOfChange(symbol): transitive blast radius of a change")
  .action(async (repo: string, symbol: string, opts: { depth: string }) => {
    const outcome = await runEngineMethod<Awaited<ReturnType<Engine["impactOfChange"]>>>(
      repo,
      {},
      "impactOfChange",
      [symbol, Number(opts.depth)],
    );
    console.log(JSON.stringify(outcome, null, 2));
  });

program
  .command("tests-for")
  .argument("<repo>")
  .argument("<symbol>")
  .description("WhichTestsExercise(symbol)")
  .action(async (repo: string, symbol: string) => {
    const outcome = await runEngineMethod<Awaited<ReturnType<Engine["whichTestsExercise"]>>>(
      repo,
      {},
      "whichTestsExercise",
      [symbol],
    );
    console.log(JSON.stringify(outcome, null, 2));
  });

program
  .command("why-changed")
  .argument("<repo>")
  .argument("<symbol>")
  .description("WhyDidChange(symbol): git/commit evidence for a symbol's history")
  .action(async (repo: string, symbol: string) => {
    const outcome = await runEngineMethod<Awaited<ReturnType<Engine["whyDidChange"]>>>(
      repo,
      {},
      "whyDidChange",
      [symbol],
    );
    console.log(JSON.stringify(outcome, null, 2));
  });

program
  .command("dependents")
  .argument("<repo>")
  .argument("<module>")
  .description("ModuleDependents(module)")
  .action(async (repo: string, moduleName: string) => {
    const outcome = await runEngineMethod<Awaited<ReturnType<Engine["moduleDependents"]>>>(
      repo,
      {},
      "moduleDependents",
      [moduleName],
    );
    console.log(JSON.stringify(outcome, null, 2));
  });

program
  .command("overview")
  .argument("<repo>")
  .option("--budget <n>", "token budget", (v) => parseInt(v, 10), 2000)
  .option("--json", "emit JSON")
  .description("RepoOverview: compressed, evidence-backed structural summary — the first-contact task before you know what symbol to ask about")
  .action(async (repo: string, opts: { budget: number; json?: boolean }) => {
    const outcome = await runEngineMethod<Awaited<ReturnType<Engine["repoOverview"]>>>(
      repo,
      {},
      "repoOverview",
      [opts.budget],
    );
    if (opts.json) {
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }
    console.log(`${outcome.root} @ ${outcome.revision}`);
    console.log(`crystallization level ${outcome.crystallization.current}: ${outcome.crystallization.description}`);
    console.log(
      `files=${outcome.totals.files} modules=${outcome.totals.modules} symbols=${outcome.totals.symbols} unresolvedImports=${outcome.totals.unresolvedImports} unknownRegions=${outcome.totals.unknownRegions} conflicts=${outcome.totals.conflicts}`,
    );
    if (outcome.unknownsByKind.length) {
      console.log("unknowns:");
      for (const u of outcome.unknownsByKind) console.log(`  ${u.kind} x${u.count}`);
    }
    console.log(`core modules (highest fan-in, ${outcome.coreModules.length} shown):`);
    for (const m of outcome.coreModules) console.log(`  ${m.module}  fanIn=${m.fanIn} fanOut=${m.fanOut} exports=${m.exportedSymbols}`);
    console.log(`leaf modules (fan-in 0, ${outcome.leafModules.length} shown):`);
    for (const m of outcome.leafModules) console.log(`  ${m.module}  fanOut=${m.fanOut}`);
    console.log(
      `tokenBudget=${outcome.tokenBudget} estimatedTokens=${outcome.estimatedTokens} truncated=${outcome.truncated} sufficient=${outcome.sufficient}`,
    );
  });

program
  .command("export-scip")
  .argument("<repo>")
  .option("--out <path>", "output .scip file", "index.scip")
  .description(
    "export currently-known facts as a SCIP index (Sourcegraph's LSIF successor) for interop with other tooling",
  )
  .action(async (repo: string, opts: { out: string }) => {
    const engine = new Engine(repo);
    await engine.index();
    const { runAnalysis, analysisByName } = await import("../analyses/library.js");
    for (const name of ["ResolveSymbols", "ResolveTypes", "ResolveCalls", "BuildReferences"]) {
      await runAnalysis(analysisByName(name), engine.context);
    }
    const index = exportScip(engine.store, engine.root);
    writeScipFile(index, opts.out);
    engine.close();
    console.log(`wrote ${opts.out}: ${index.documents.length} documents, ${index.documents.reduce((n, d) => n + d.symbols.length, 0)} symbols`);
  });

program
  .command("search")
  .argument("<repo>")
  .argument("<query>")
  .description("tiered search: canonical entity -> symbol -> lexical BM25")
  .action(async (repo: string, query: string) => {
    const engine = new Engine(repo);
    await engine.index();
    const { runAnalysis, analysisByName } = await import("../analyses/library.js");
    await runAnalysis(analysisByName("ResolveSymbols"), engine.context);
    const bm25 = new Bm25Index(engine.root, listSourceFiles(engine.root));
    console.log(JSON.stringify(search(engine.store, query, { bm25 }), null, 2));
  });

program
  .command("baseline")
  .argument("<repo>")
  .argument("<symbol>")
  .description("conventional index+lexical pipeline, for comparison")
  .action(async (repo: string, symbol: string) => {
    const outcome = await runBaselineFindCallers(repo, symbol);
    console.log(JSON.stringify(outcome, null, 2));
  });

await program.parseAsync(process.argv);
