// Ad-hoc verification, not a vitest suite: this sandbox has no network
// access to `npm install` vitest (see IMPLEMENTATION-REPORT.md §12). Run
// from the repo root: `npx tsx tests/adhoc/<name>.mts`. Exits non-zero on
// any failed assertion, so it's CI-usable as-is once vitest is installable.
import { Engine } from "../../src/engine/engine.js";
import { crystallizationLevel } from "../../src/crystallization/levels.js";

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

// ---- 1. TS-only repo: crystallization must NOT be capped at 0 by the new
// Python analyses now sitting in ANALYSIS_LEVEL. This is the exact
// regression the whole design change exists to prevent.
{
  const engine = new Engine("tests/fixtures/repo-a", { cache: false, autoPersist: false });
  await engine.index();
  const c1 = engine.crystallization();
  check("TS-only repo still reaches crystallization level 1 after index()", c1.current === 1, `got ${c1.current}`);
  check(
    "level-1 missingForNextLevel does not list any Python analysis (not applicable to this repo)",
    !c1.missingForNextLevel.some((n) => n.startsWith("Python") || n.includes("Python")),
    JSON.stringify(c1.missingForNextLevel),
  );
  const overview = await engine.repoOverview(2000);
  check("repoOverview on TS-only repo still reports crystallization 1", overview.crystallization.current === 1);
  engine.close();
}

// ---- 2. Unfiltered crystallizationLevel() (no applicable list) now treats
// every declared analysis as applicable, including conditional ones — this
// is DIFFERENT from before conditional analyses existed, and documented as
// such (see the docstring). Confirm that documented behavior directly
// rather than asserting stale pre-Python semantics.
{
  const withoutFilter = crystallizationLevel(["ParseSource|repository"]);
  check(
    "unfiltered call now correctly reports level 0 (ParsePythonSource counted as missing)",
    withoutFilter.current === 0 && withoutFilter.missingForNextLevel.includes("ParsePythonSource"),
    JSON.stringify(withoutFilter),
  );
  const withFilter = crystallizationLevel(["ParseSource|repository"], ["ParseSource"]);
  check(
    "same completed-set WITH an applicable filter correctly reports level 1",
    withFilter.current === 1,
    JSON.stringify(withFilter),
  );
}

// ---- 3. Engine.indexPython() end-to-end against the Python fixture repo
{
  const engine = new Engine("tests/fixtures/py-repo-a", { cache: false, autoPersist: false });
  const res = await engine.indexPython();
  check("indexPython files=3", res.files === 3, JSON.stringify(res));
  check("indexPython modules=3", res.modules === 3, JSON.stringify(res));
  check("indexPython classes=2", res.classes === 2, JSON.stringify(res));
  check("indexPython methods=2", res.methods === 2, JSON.stringify(res));
  check("indexPython functions=3", res.functions === 3, JSON.stringify(res));
  check("indexPython parseErrors=0", res.parseErrors === 0, JSON.stringify(res));
  check("indexPython callSites > 0", res.callSites > 0, JSON.stringify(res));

  // ParseSource (the TS track) is applicable to every repo unconditionally
  // (it always runs, even to confirm zero TS files exist -- see ParseSource's
  // precondition), and so are ResolveSymbols/BuildReferences/ResolveTypes/
  // AnalyzeInheritance/ResolveCalls: none of the *existing* TS analyses were
  // given a "only if TS files exist" applicability guard (deliberately out
  // of scope here -- they're relied on by the full existing TS test suite
  // and changing their applicability is a separate, riskier decision from
  // adding Python). So a repo-wide crystallization level is genuinely a
  // joint measure across both tracks: reaching level 3 on a Python-only
  // repo means running the (here, trivially cheap: 0 TS files) TS pipeline
  // too, the way a real caller doing a full index would.
  await engine.index();
  const { runAnalysis, analysisByName } = await import("../../src/analyses/library.js");
  for (const name of ["ResolveSymbols", "BuildReferences", "ResolveTypes", "AnalyzeInheritance", "ResolveCalls"]) {
    await runAnalysis(analysisByName(name), engine.context);
  }
  const c = engine.crystallization();
  check(
    "py-repo-a reaches crystallization level 3 once both language tracks are fully run",
    c.current === 3,
    `got ${c.current}, missing=${JSON.stringify(c.missingForNextLevel)}`,
  );
  check(
    "all 3 Python analyses show up in completedAnalyses",
    ["ParsePythonSource", "ResolvePythonSymbols", "ResolvePythonCalls"].every((n) => c.completedAnalyses.includes(n)),
    JSON.stringify(c.completedAnalyses),
  );
  engine.close();
}

// ---- 4. Repo with NEITHER .py nor recognizable TS files: indexPython must
// return all-zero, not throw.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const emptyDir = "/tmp/sie-empty-repo";
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, "README.md"), "nothing here");
  const engine = new Engine(emptyDir, { cache: false, autoPersist: false });
  const res = await engine.indexPython();
  check("indexPython on a repo with no .py files returns all zeros, no throw", res.files === 0 && res.modules === 0, JSON.stringify(res));
  engine.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
