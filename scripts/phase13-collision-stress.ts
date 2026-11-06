/**
 * Phase 1.3 — oracle name-collision stress test.
 *
 * Fixture: tests/fixtures/repo-collide, containing three unrelated `foo`
 * declarations, two same-named classes/constructors (`Widget`), two identical
 * method names (`render`), aliases, re-exports and a nested declaration that
 * shadows a module-level name.
 *
 * This is an ORACLE test, not an engine test. It asks a single question:
 * does `callImpactOracle`'s textual-name fixed point merge unrelated symbols
 * into one impact closure? Expected-by-construction answers are written here
 * by hand from the fixture source.
 */
import fs from "node:fs";
import path from "node:path";
import { callImpactOracle } from "../src/experiment/oracles-ext.js";
import { callImpactOracleAt } from "../src/experiment/oracles-identity.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const REPO = path.join(ROOT, "tests/fixtures/repo-collide");

/** Hand-written from the fixture: impact closure per *declaration site*. */
const CASES: { name: string; declFile: string; expected: string[]; note: string }[] = [
  { name: "foo", declFile: "src/fileA.ts", expected: ["src/fileA.ts", "src/callersA.ts", "src/barrel-users.ts"], note: "fileA.foo; reached via direct import and via the barrel alias fooFromA" },
  { name: "foo", declFile: "src/fileB.ts", expected: ["src/fileB.ts", "src/callersB.ts"], note: "fileB.foo; the barrel re-exports it as fooFromB but nothing calls that" },
  { name: "foo", declFile: "src/fileC.ts", expected: ["src/fileC.ts", "src/callersC.ts"], note: "fileC.foo" },
  { name: "helperA", declFile: "src/fileA.ts", expected: ["src/fileA.ts", "src/callersA.ts", "src/barrel-users.ts"], note: "transitive through fileA.foo only" },
  { name: "helperB", declFile: "src/fileB.ts", expected: ["src/fileB.ts", "src/callersB.ts"], note: "transitive through fileB.foo only" },
  { name: "render", declFile: "src/widgets.ts", expected: ["src/widgets.ts", "src/widget-users.ts"], note: "Widget.render; the alt Widget's identically-named render is a different symbol" },
  { name: "render", declFile: "src/widgets-alt.ts", expected: ["src/widgets-alt.ts", "src/widget-users.ts"], note: "AltWidget.render" },
];

const results: any[] = [];
for (const c of CASES) {
  const naive = callImpactOracle(REPO, c.name).map((f) => f.replace(/\\/g, "/")).sort();
  const identity = callImpactOracleAt(REPO, c.name, c.declFile).map((f) => f.replace(/\\/g, "/")).sort();
  const exp = [...c.expected].sort();
  const eq = (a: string[]) => a.length === exp.length && a.every((x, i) => x === exp[i]);
  results.push({
    name: c.name,
    declFile: c.declFile,
    note: c.note,
    expected: exp,
    nameKeyedOracle: naive,
    nameKeyedCorrect: eq(naive),
    nameKeyedOverReach: naive.filter((f) => !exp.includes(f)),
    identityKeyedOracle: identity,
    identityKeyedCorrect: eq(identity),
    identityKeyedOverReach: identity.filter((f) => !exp.includes(f)),
    identityKeyedMissing: exp.filter((f) => !identity.includes(f)),
  });
}

const outDir = path.join(ROOT, "results/raw");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "phase13-collision-stress.json");
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), repo: "repo-collide", results }, null, 2));

for (const r of results) {
  console.log(
    `${r.name} @ ${r.declFile}\n  expected : ${r.expected.join(", ")}\n  by-name  : ${r.nameKeyedCorrect ? "OK  " : "MERGE"} ${r.nameKeyedOracle.join(", ")}\n  by-ident : ${r.identityKeyedCorrect ? "OK  " : "FAIL "} ${r.identityKeyedOracle.join(", ")}`,
  );
}
const nameOk = results.filter((r) => r.nameKeyedCorrect).length;
const idOk = results.filter((r) => r.identityKeyedCorrect).length;
console.log(`\nname-keyed oracle correct: ${nameOk}/${results.length}`);
console.log(`identity-keyed oracle correct: ${idOk}/${results.length}`);
console.log(`wrote ${out}`);
