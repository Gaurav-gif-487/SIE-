// Ad-hoc verification, not a vitest suite: this sandbox has no network
// access to `npm install` vitest (see IMPLEMENTATION-REPORT.md §12). Run
// from the repo root: `npx tsx tests/adhoc/<name>.mts`. Exits non-zero on
// any failed assertion, so it's CI-usable as-is once vitest is installable.
import { handle } from "../../src/api/mcp-server.js";

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

const tools = (await handle({ jsonrpc: "2.0", method: "tools/list" })) as { tools: { name: string }[] };
check(
  "index_python_repository is registered in tools/list",
  tools.tools.some((t) => t.name === "index_python_repository"),
  tools.tools.map((t) => t.name).join(","),
);

const result = (await handle({
  jsonrpc: "2.0",
  method: "tools/call",
  params: { name: "index_python_repository", arguments: { repo: "tests/fixtures/py-repo-a" } },
})) as { content: { type: string; text: string }[] };
const payload = JSON.parse(result.content[0]!.text);
check("MCP index_python_repository returns files=3", payload.files === 3, JSON.stringify(payload));
check("MCP index_python_repository returns classes=2", payload.classes === 2, JSON.stringify(payload));
check("MCP index_python_repository returns methods=2", payload.methods === 2, JSON.stringify(payload));

// crystallization_report through MCP on the same (now warm) engine should
// reflect the Python analyses without needing the TS track for this check
const cryst = (await handle({
  jsonrpc: "2.0",
  method: "tools/call",
  params: { name: "crystallization_report", arguments: { repo: "tests/fixtures/py-repo-a" } },
})) as { content: { type: string; text: string }[] };
const crystPayload = JSON.parse(cryst.content[0]!.text);
check(
  "MCP crystallization_report includes Python analyses in completedAnalyses",
  ["ParsePythonSource", "ResolvePythonSymbols", "ResolvePythonCalls"].every((n) =>
    crystPayload.completedAnalyses.includes(n),
  ),
  JSON.stringify(crystPayload.completedAnalyses),
);

// existing TS-only tool still works through the same server, unaffected
const tsIndex = (await handle({
  jsonrpc: "2.0",
  method: "tools/call",
  params: { name: "index_repository", arguments: { repo: "tests/fixtures/repo-a" } },
})) as { content: { type: string; text: string }[] };
const tsPayload = JSON.parse(tsIndex.content[0]!.text);
check("MCP index_repository (TS) still works, unaffected", typeof tsPayload.files === "number", JSON.stringify(tsPayload));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
