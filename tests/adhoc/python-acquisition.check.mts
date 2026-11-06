// Ad-hoc verification, not a vitest suite: this sandbox has no network
// access to `npm install` vitest (see IMPLEMENTATION-REPORT.md §12). Run
// from the repo root: `npx tsx tests/adhoc/<name>.mts`. Exits non-zero on
// any failed assertion, so it's CI-usable as-is once vitest is installable.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeStore } from "../../src/knowledge/store.js";
import { newCounters } from "../../src/cost/measure.js";
import { Resolution } from "../../src/canonical/model.js";
import {
  indexPythonRepository,
  listPythonFiles,
  loadPythonProgram,
} from "../../src/acquisition/python.js";

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

const root = "tests/fixtures/py-repo-a";

// 1. file discovery
const files = listPythonFiles(root);
check("listPythonFiles finds 3 .py files", files.length === 3, `got ${files.length}: ${files.join(", ")}`);

// 2. full index
const store = new KnowledgeStore(root, "test-revision");
const counters = newCounters();
const extracted = indexPythonRepository(root, store, counters);

check("no parse errors", extracted.errors.length === 0, JSON.stringify(extracted.errors));
check("3 files extracted", extracted.files.length === 3, `got ${extracted.files.length}`);
check("filesProcessed counter is 3", counters.filesProcessed === 3, `got ${counters.filesProcessed}`);

// 3. entities
const fileEntities = store.entitiesOfKind("File");
const moduleEntities = store.entitiesOfKind("Module");
const functionEntities = store.entitiesOfKind("Function");
const methodEntities = store.entitiesOfKind("Method");
const classEntities = store.entitiesOfKind("Class");

check("3 File entities", fileEntities.length === 3, `got ${fileEntities.length}`);
check("3 Module entities", moduleEntities.length === 3, `got ${moduleEntities.length}`);
check(
  "module dotted names correct",
  moduleEntities.some((m) => m.name === "pkg") &&
    moduleEntities.some((m) => m.name === "pkg.util") &&
    moduleEntities.some((m) => m.name === "pkg.service"),
  moduleEntities.map((m) => m.name).join(","),
);

check(
  "2 Class entities (Base, Worker)",
  classEntities.length === 2,
  classEntities.map((c) => c.name).join(","),
);
check(
  "1 Method (Worker.run, Base.run -> 2 methods actually)",
  methodEntities.length === 2,
  methodEntities.map((m) => m.name).join(","),
);
check(
  "3 top-level Functions (util.helper, util.helper_unused, service.helper)",
  functionEntities.length === 3,
  functionEntities.map((f) => f.name).join(","),
);

// 4. IMPORTS resolution: `from .util import helper` in service.py should resolve to pkg.util module
const importsFromService = store
  .relationsOfKind("IMPORTS")
  .filter((r) => r.location?.file === "pkg/service.py");
const relativeImport = importsFromService.find((r) => r.attributes.statement === "from .util import helper");
check(
  "relative import 'from .util import helper' resolves to pkg.util module",
  !!relativeImport && relativeImport.resolution === Resolution.PARTIAL && relativeImport.to !== null,
  JSON.stringify(relativeImport),
);
const osImport = importsFromService.find((r) => r.attributes.statement === "import os");
check(
  "absolute stdlib import 'import os' is UNRESOLVED + external",
  !!osImport && osImport.resolution === Resolution.UNRESOLVED && osImport.attributes.external === true,
  JSON.stringify(osImport),
);

// 5. CALLS resolution: Worker.run() calls helper(21) -- this is the deliberate
// ambiguous fixture: pkg.util.helper AND pkg.service.helper both named "helper"
const calls = store.relationsOfKind("CALLS");
const helperCalls = calls.filter((r) => r.attributes.calleeText === "helper");
check(
  "call to 'helper' inside Worker.run is AMBIGUOUS (2 same-name candidates)",
  helperCalls.some((r) => r.resolution === Resolution.AMBIGUOUS && r.attributes.candidateCount === 2),
  JSON.stringify(helperCalls),
);
const ambiguousUnknowns = store.unknownRegions("ambiguous-call");
check("ambiguous-call UnknownRegion recorded", ambiguousUnknowns.length >= 1, `${ambiguousUnknowns.length}`);

// 6. builtin call (str via .__str__ attribute access is NOT in the builtin
// no-op list since it's an attribute call) -- check os.path.join (attribute call)
// is UNRESOLVED without being flagged "builtin" (since builtin list only
// covers bare-name calls, not attribute calls -- honest about that limit)
const joinCalls = calls.filter((r) => r.attributes.calleeText === "join");
check("os.path.join call captured as CALLS with UNRESOLVED target", joinCalls.length === 1 && joinCalls[0]!.to === null, JSON.stringify(joinCalls));

// 7. DECLARES edges: Worker class DECLARES its 'run' method
const declares = store.relationsOfKind("DECLARES");
const workerId = classEntities.find((c) => c.name === "Worker")!.id;
const workerDeclares = declares.filter((r) => r.from === workerId);
check("Worker DECLARES exactly 1 method (run)", workerDeclares.length === 1, `${workerDeclares.length}`);

// 8. evidence exists and is attributed to the right analyses
const ev = store.allEvidence();
check("evidence recorded with sourceType python-ast", ev.every((e) => e.sourceType === "python-ast"), "");
check(
  "evidence producedBy includes ParsePythonSource and ResolvePythonSymbols",
  ev.some((e) => e.producedBy === "ParsePythonSource") && ev.some((e) => e.producedBy === "ResolvePythonSymbols"),
  [...new Set(ev.map((e) => e.producedBy))].join(","),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
