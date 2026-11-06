// Ad-hoc verification, not a vitest suite (see python-wiring.check.mts for
// why). Run from the repo root: `npx tsx tests/adhoc/python-callers.check.mts`.
// Exits non-zero on any failed assertion.
import fs from "node:fs";
import path from "node:path";
import { Engine } from "../../src/engine/engine.js";
import { Resolution } from "../../src/canonical/model.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? " -- " + detail : ""}`);
  }
}

// ---- 1. Ambiguous call: py-repo-a/pkg/service.py's Worker.run() calls
// helper(21), and "helper" name-matches BOTH pkg/util.py::helper and
// pkg/service.py's own top-level helper() (deliberate fixture collision).
// Querying the unqualified name "helper" should surface it as ambiguous,
// not confirmed/possible, since there's no type checker to disambiguate.
{
  const engine = new Engine("tests/fixtures/py-repo-a", { cache: false, autoPersist: false });
  const outcome = await engine.findPythonCallers("helper");
  const r = outcome.result;

  check("targets: two declarations named 'helper' found", r.targets.length === 2, JSON.stringify(r.targets));
  check(
    "targetSelectionStatus is AMBIGUOUS for an unqualified, colliding name",
    r.targetSelectionStatus === "AMBIGUOUS",
  );
  check(
    "the helper(21) call site inside Worker.run is classified ambiguous, not possible",
    r.ambiguous.some((c) => c.calleeText === "helper" && c.callSite.line === 12),
    JSON.stringify(r.ambiguous),
  );
  check(
    "the ambiguous finding carries resolution=AMBIGUOUS and candidateCount=2",
    r.ambiguous.some((c) => c.resolution === Resolution.AMBIGUOUS && c.candidateCount === 2),
    JSON.stringify(r.ambiguous),
  );
  check("no 'possible' finding for the ambiguous call site itself", r.possible.length === 0, JSON.stringify(r.possible));
  check(
    "risk flags the ambiguous call as a critical site, unacceptable",
    outcome.risk.criticalSites >= 1 && outcome.risk.acceptable === false,
    JSON.stringify(outcome.risk),
  );
  check("uncertainty is quantified (denominator known)", outcome.uncertainty.value !== null, JSON.stringify(outcome.uncertainty));
  check("evidence is non-empty for the ambiguous call site", outcome.result.evidence.length > 0, JSON.stringify(outcome.result.evidence.length));
  engine.close();
}

// ---- 2. Container-based disambiguation: querying "Worker.run" (qualified)
// should resolve to exactly the one method inside class Worker, distinct
// from Base.run.
{
  const engine = new Engine("tests/fixtures/py-repo-a", { cache: false, autoPersist: false });
  const outcome = await engine.findPythonCallers("Worker.run");
  const r = outcome.result;
  check("qualified query 'Worker.run' resolves to exactly one target", r.targets.length === 1, JSON.stringify(r.targets));
  check(
    "the resolved target's container is 'Worker'",
    r.targets[0]?.container === "Worker",
    JSON.stringify(r.targets),
  );
  check("targetSelectionStatus is RESOLVED for the qualified query", r.targetSelectionStatus === "RESOLVED");
  engine.close();
}

// ---- 3. A single, unambiguous, unqualified name-match should classify as
// 'possible' (never 'confirmed' -- Python resolution has no EXACT ceiling).
// pkg/util.py::helper_unused has no callers, so use a name that does:
// util.py's own module has no call to helper_unused; instead confirm the
// classification vocabulary directly by checking the type/shape.
{
  const engine = new Engine("tests/fixtures/py-repo-a", { cache: false, autoPersist: false });
  const outcome = await engine.findPythonCallers("Worker.run");
  const r = outcome.result;
  check(
    "result has no 'confirmed' bucket at all (compile-time shape, not runtime)",
    !("confirmed" in r),
    JSON.stringify(Object.keys(r)),
  );
  check(
    "every possible/ambiguous finding's resolution is PARTIAL or AMBIGUOUS, never EXACT",
    [...r.possible, ...r.ambiguous].every((f) => f.resolution !== Resolution.EXACT),
  );
  engine.close();
}

// ---- 4. Zero .py files: must return ANALYSIS_UNSUPPORTED, not throw and
// not silently claim SUFFICIENT.
{
  const emptyDir = "/tmp/sie-empty-repo-pycallers";
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, "README.md"), "nothing here");
  const engine = new Engine(emptyDir, { cache: false, autoPersist: false });
  const outcome = await engine.findPythonCallers("anything");
  check(
    "repo with no .py files reports verdict=ANALYSIS_UNSUPPORTED",
    outcome.verdict === "ANALYSIS_UNSUPPORTED",
    JSON.stringify({ verdict: outcome.verdict, stopReason: outcome.stopReason }),
  );
  check("no throw, and result is still well-formed (empty targets)", outcome.result.targets.length === 0);
  engine.close();
}

// ---- 5. MCP registration: find_python_callers must be a listed tool and
// dispatch correctly.
{
  const { handle } = await import("../../src/api/mcp-server.js");
  const list = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as { tools: { name: string }[] };
  check(
    "find_python_callers is registered in tools/list",
    list.tools.some((t) => t.name === "find_python_callers"),
    JSON.stringify(list.tools.map((t) => t.name)),
  );
  const call = (await handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "find_python_callers", arguments: { repo: "tests/fixtures/py-repo-a", symbol: "helper" } },
  })) as { content: { type: string; text: string }[] };
  const parsed = JSON.parse(call.content[0]!.text);
  check(
    "find_python_callers tool call returns a well-formed outcome via MCP",
    parsed.result?.symbol === "helper" && Array.isArray(parsed.result?.ambiguous),
    JSON.stringify(parsed).slice(0, 300),
  );
}

// ---- 6. CRITICAL REGRESSION CHECK: the staleFiles() fix. Construct a
// second Engine (fresh process-level object, but same on-disk persistent
// cache) against a Python repo and confirm Python facts survive -- this is
// the exact bug from the earlier root-cause analysis: every .py file used
// to look "stale" on the second construction because listSourceFiles() was
// TS/JS-only, so invalidateFile() silently wiped every Python entity while
// isAnalysisComplete() kept reporting the analysis as done.
{
  const cacheDir = "/tmp/sie-cache-pycallers-regression";
  fs.rmSync(cacheDir, { recursive: true, force: true });

  const first = new Engine("tests/fixtures/py-repo-a", { cacheDir, autoPersist: true });
  const firstOutcome = await first.findPythonCallers("helper");
  const firstAmbiguousCount = firstOutcome.result.ambiguous.length;
  check("first Engine: ambiguous findings present", firstAmbiguousCount > 0, `got ${firstAmbiguousCount}`);
  first.close();

  const second = new Engine("tests/fixtures/py-repo-a", { cacheDir, autoPersist: true });
  check(
    "second Engine: Python analyses are NOT wrongly marked stale on construction",
    second.refresh().stale.filter((f) => f.endsWith(".py")).length === 0,
    JSON.stringify(second.refresh()),
  );
  const secondOutcome = await second.findPythonCallers("helper");
  check(
    "second Engine: findPythonCallers still finds the ambiguous call (facts survived)",
    secondOutcome.result.ambiguous.length === firstAmbiguousCount,
    `first=${firstAmbiguousCount} second=${secondOutcome.result.ambiguous.length}`,
  );
  check(
    "second Engine: isAnalysisComplete claims match reality -- entities actually exist",
    second.store.entitiesOfKind("Function").filter((e) => e.attributes.language === "python").length > 0,
  );
  second.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
