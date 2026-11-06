import path from "node:path";
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { ANALYSES } from "../src/analyses/library.js";

const REPO = path.resolve(__dirname, "fixtures/repo-a");

describe("soundness declarations", () => {
  it("every registered analysis declares its soundness class", () => {
    const allowed = new Set(["SOUND", "SOUND_UNDER_ASSUMPTIONS", "HEURISTIC", "OBSERVATIONAL", "SPECULATIVE"]);
    for (const analysis of ANALYSES) {
      expect(allowed.has(analysis.soundness), `${analysis.name} has an unrecognized soundness value`).toBe(true);
    }
  });

  it("structural compiler analyses are not claimed unconditionally SOUND", () => {
    // The engine cannot see reflection, dynamic dispatch, or generated code,
    // so compiler-derived structural analyses must declare their assumptions
    // rather than claim unconditional soundness.
    const resolveCalls = ANALYSES.find((a) => a.name === "ResolveCalls")!;
    expect(resolveCalls.soundness).toBe("SOUND_UNDER_ASSUMPTIONS");
  });

  it("observational analyses (git, coverage, runtime) are marked OBSERVATIONAL, not SOUND", () => {
    for (const name of ["AnalyzeGitHistory", "IngestCoverage", "IngestRuntimeTrace"]) {
      const analysis = ANALYSES.find((a) => a.name === name)!;
      expect(analysis.soundness).toBe("OBSERVATIONAL");
    }
  });
});

describe("outcome verdicts (failure is a first-class result)", () => {
  it("reports SUFFICIENT when required evidence exists and risk is acceptable", async () => {
    const engine = new Engine(REPO);
    // Not FastRunner.run: it is also reachable through
    // `useInterface(r: Runner)` in consumer.ts, an interface-typed parameter
    // whose concrete implementation is genuinely undecidable statically, so
    // its uncertainty can never drop to the sufficiency threshold no matter
    // how much evidence is gathered. AdminService.authenticate has no such
    // virtual-dispatch call site and is fully resolved by direct calls only,
    // so it is the correct example of an outcome that reaches SUFFICIENT.
    const outcome = await engine.findCallers("AdminService.authenticate");
    expect(outcome.verdict).toBe("SUFFICIENT");
    expect(outcome.sufficient).toBe(true);
  });

  it("never reports SUFFICIENT when the planner did not consider the outcome sufficient", async () => {
    // required-only mode stops as soon as required analyses are satisfied,
    // without necessarily driving residual risk down further; whatever
    // verdict it reports must be consistent with `sufficient`.
    const engine = new Engine(REPO, { plannerMode: "required-only" });
    const outcome = await engine.findCallers("FastRunner.run");
    expect(outcome.verdict === "SUFFICIENT").toBe(outcome.sufficient);
  });
});
