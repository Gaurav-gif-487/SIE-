import path from "node:path";
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { compareEvidence } from "../src/verification/compare.js";
import { decideVerification } from "../src/verification/policy.js";
import { CHALLENGE_ANALYSIS_VERSION } from "../src/verification/challenge.js";

const REPO_A = path.resolve(__dirname, "fixtures/repo-a");
const REPO_B = path.resolve(__dirname, "fixtures/repo-b");

// ---------------------------------------------------------------------------
// Pure logic: compareEvidence and decideVerification are deterministic, pure
// functions with no TypeScript compilation involved, so these are exact and
// do not depend on how the language service happens to behave on a fixture.
// ---------------------------------------------------------------------------

describe("compareEvidence (pure comparison logic)", () => {
  it("identical sets: CONFIRMED", () => {
    const cmp = compareEvidence(["a.ts:1", "b.ts:2"], ["a.ts:1", "b.ts:2"]);
    expect(cmp.outcome).toBe("CONFIRMED");
    expect(cmp.onlyInPrimary).toEqual([]);
    expect(cmp.onlyInChallenge).toEqual([]);
  });

  it("disjoint sets: CONTRADICTED", () => {
    const cmp = compareEvidence(["a.ts:1"], ["b.ts:2"]);
    expect(cmp.outcome).toBe("CONTRADICTED");
    expect(cmp.agreedCount).toBe(0);
  });

  it("challenge is a strict superset: PARTIALLY_CONFIRMED, disagreement never discarded", () => {
    const cmp = compareEvidence(["a.ts:1"], ["a.ts:1", "b.ts:2"]);
    expect(cmp.outcome).toBe("PARTIALLY_CONFIRMED");
    expect(cmp.onlyInChallenge).toEqual(["b.ts:2"]);
  });

  it("partial overlap in both directions: CONFLICTING, not silently reconciled", () => {
    const cmp = compareEvidence(["a.ts:1", "b.ts:2"], ["a.ts:1", "c.ts:3"]);
    expect(cmp.outcome).toBe("CONFLICTING");
    expect(cmp.onlyInPrimary).toEqual(["b.ts:2"]);
    expect(cmp.onlyInChallenge).toEqual(["c.ts:3"]);
  });

  it("both empty: UNVERIFIED, not CONFIRMED by default", () => {
    const cmp = compareEvidence([], []);
    expect(cmp.outcome).toBe("UNVERIFIED");
  });
});

describe("decideVerification (policy)", () => {
  const clean = {
    criticality: "normal" as const,
    residualRiskSites: 0,
    hasConflictingEvidence: false,
    hasDynamicDispatch: false,
    hasReflection: false,
    hasIncompleteCoverage: false,
    unresolvedSiteCount: 0,
    weakestSoundness: "SOUND_UNDER_ASSUMPTIONS" as const,
  };

  it("clean evidence: not-required", () => {
    expect(decideVerification(clean).level).toBe("not-required");
  });

  it("dynamic dispatch present: required, and says why", () => {
    const d = decideVerification({ ...clean, hasDynamicDispatch: true });
    expect(d.level).toBe("required");
    expect(d.reasons.some((r) => r.includes("dynamic dispatch"))).toBe(true);
  });

  it("conflicting evidence: required", () => {
    expect(decideVerification({ ...clean, hasConflictingEvidence: true }).level).toBe("required");
  });

  it("residual risk at/above threshold: required", () => {
    expect(decideVerification({ ...clean, residualRiskSites: 1 }, { requiredRiskThreshold: 1, unresolvedSiteFloor: 1 }).level).toBe(
      "required",
    );
  });

  it("high criticality with zero risk: recommended, not required (does not manufacture required)", () => {
    const d = decideVerification({ ...clean, criticality: "high" });
    expect(d.level).toBe("recommended");
  });

  it("high criticality with nonzero risk: required", () => {
    const d = decideVerification({ ...clean, criticality: "high", residualRiskSites: 1 });
    expect(d.level).toBe("required");
  });

  it("weak soundness alone: recommended, not required", () => {
    const d = decideVerification({ ...clean, weakestSoundness: "OBSERVATIONAL" });
    expect(d.level).toBe("recommended");
  });
});

// ---------------------------------------------------------------------------
// Real-repository integration. Fixtures and expectations are traced against
// the actual acquisition/planner code paths (see report), not hardcoded
// guesses: e.g. JsonHandler.handle is independently hand-labelled in
// tests/groundtruth/repo-b.labels.json as having a "dynamic" call site
// (src/indirect.ts:36, computed member access `h[key]("k")`).
// ---------------------------------------------------------------------------

describe("verification layer on real repositories", () => {
  it("[skip when unnecessary] a query with no dynamic/reflective sites is not verified", async () => {
    const engine = new Engine(REPO_A);
    const out = await engine.findCallers("FastRunner.run");
    // consumer.ts has an unrelated dynamic-dispatch/reflection call elsewhere
    // in the file, but neither is among *this* query's own unresolved sites
    // (see verify.ts's targetScopedRisk comment) - the policy must not
    // trigger on repo-wide noise.
    expect(out.result.unresolvedSites.filter((s) => s.risk === "dynamic-dispatch" || s.risk === "reflection")).toEqual([]);
    expect(out.verification.decision.level).toBe("not-required");
    expect(out.verification.ran).toBe(false);
    expect(out.verification.challenge).toBeNull();
  });

  it("[skip when unnecessary, and RESOLVED] a fully-resolved clean query reaches RESOLVED without verification", async () => {
    // AdminService.authenticate: single direct call site, no dynamic/reflective
    // sites anywhere relevant, required analyses alone bring uncertainty to 0.
    const engine = new Engine(REPO_A);
    const out = await engine.findCallers("AdminService.authenticate");
    expect(out.verdict).toBe("SUFFICIENT");
    expect(out.verification.decision.level).toBe("not-required");
    expect(out.verification.ran).toBe(false);
    expect(out.finalStatus).toBe("RESOLVED");
  });

  it("[dynamic call requires verification] a computed-access call site forces the challenge to run", async () => {
    const engine = new Engine(REPO_B);
    const out = await engine.findCallers("JsonHandler.handle");
    const dynamicSites = out.result.unresolvedSites.filter((s) => s.risk === "dynamic-dispatch");
    expect(dynamicSites.length).toBeGreaterThan(0);
    expect(out.verification.decision.level).toBe("required");
    expect(out.verification.decision.reasons.some((r) => r.includes("dynamic dispatch"))).toBe(true);
    expect(out.verification.ran).toBe(true);
    expect(out.verification.challenge).not.toBeNull();
    expect(out.verification.challenge!.method).toBe("language-service-refs");
  }, 30000);

  it("[high-criticality requires verification] a high-criticality query is challenged even with clean primary evidence", async () => {
    const engine = new Engine(REPO_A);
    const normal = await engine.findCallers("AdminService.authenticate");
    expect(normal.verification.ran).toBe(false);

    const engine2 = new Engine(REPO_A);
    const critical = await engine2.findCallers("AdminService.authenticate", { criticality: "high" });
    expect(critical.verification.decision.level).toBe("recommended");
    expect(critical.verification.ran).toBe(true);
    expect(critical.verification.challenge).not.toBeNull();
  }, 30000);

  it("[agreement] every primary claim is corroborated by the independent challenge, never contradicted", async () => {
    const engine = new Engine(REPO_B);
    const out = await engine.findCallers("JsonHandler.handle");
    expect(out.verification.comparison).not.toBeNull();
    const cmp = out.verification.comparison!;
    // The independent mechanism is documented (challenge.ts) as over-inclusive,
    // never under-inclusive, relative to the primary path — so every site the
    // primary path claimed must be corroborated.
    expect(cmp.onlyInPrimary).toEqual([]);
    expect(["CONFIRMED", "PARTIALLY_CONFIRMED"]).toContain(cmp.outcome);
  }, 30000);

  it("[incomplete evidence remains incomplete] an unresolvable query is never reported as RESOLVED", async () => {
    const engine = new Engine(REPO_A);
    const out = await engine.findCallers("NoSuchSymbolAnywhere");
    expect(out.sufficient).toBe(false);
    expect(out.finalStatus).not.toBe("RESOLVED");
    expect(out.finalStatus).not.toBe("RESOLVED_WITH_VERIFICATION");
  });

  it("[provenance] challenge evidence carries every required provenance field, none manufactured", async () => {
    const engine = new Engine(REPO_B);
    const out = await engine.findCallers("JsonHandler.handle");
    const challenge = out.verification.challenge!;
    expect(challenge.evidence.length).toBeGreaterThan(0);
    for (const e of challenge.evidence) {
      expect(e.source).toBe("ts.LanguageService#findReferences");
      expect(e.sourceType).toBe("typescript-language-service");
      expect(e.revision).toBe(engine.store.revision);
      expect(e.analysisName).toBe("ChallengeFindCallers");
      expect(e.analysisVersion).toBe(CHALLENGE_ANALYSIS_VERSION);
      expect(e.inputs.length).toBeGreaterThan(0);
      expect(e.assumptions.length).toBeGreaterThan(0);
      expect(e.coverage).toBe("full-repository");
      expect(e.dependencies).toEqual([]); // independent: does not depend on primary evidence
      expect(e.soundness).toBe("SOUND_UNDER_ASSUMPTIONS");
      expect(typeof e.observedAt).toBe("string");
    }
  }, 30000);

  it("[no false callers] challenge-only sites are never merged into the primary confirmed/possible result", async () => {
    const engine = new Engine(REPO_B);
    const out = await engine.findCallers("JsonHandler.handle");
    const cmp = out.verification.comparison;
    if (!cmp || cmp.onlyInChallenge.length === 0) return; // nothing extra this run; assertion vacuously holds
    const primarySites = new Set(
      [...out.result.confirmed, ...out.result.possible].map((f) => `${f.callSite.file}:${f.callSite.line}`),
    );
    for (const site of cmp.onlyInChallenge) {
      expect(primarySites.has(site)).toBe(false);
    }
  }, 30000);

  it("a conflict is never converted into RESOLVED or RESOLVED_WITH_VERIFICATION", async () => {
    const { classifyFinalStatus } = await import("../src/verification/verify.js");
    const baseOutcome = { verdict: "SUFFICIENT" as const } as any;
    const contradicted = compareEvidence(["a.ts:1"], ["b.ts:2"]);
    const conflicting = compareEvidence(["a.ts:1", "b.ts:2"], ["a.ts:1", "c.ts:3"]);
    const confirmed = compareEvidence(["a.ts:1"], ["a.ts:1"]);

    expect(
      classifyFinalStatus(baseOutcome, { decision: { level: "required", reasons: [] }, ran: true, challenge: null, comparison: contradicted }),
    ).toBe("CONFLICTING");
    expect(
      classifyFinalStatus(baseOutcome, { decision: { level: "required", reasons: [] }, ran: true, challenge: null, comparison: conflicting }),
    ).toBe("CONFLICTING");
    // Sanity: the same primary verdict with a CONFIRMED comparison is allowed to resolve.
    expect(
      classifyFinalStatus(baseOutcome, { decision: { level: "required", reasons: [] }, ran: true, challenge: null, comparison: confirmed }),
    ).toBe("RESOLVED_WITH_VERIFICATION");
    // A primary CONFLICTING_EVIDENCE verdict is never overridden by a clean challenge.
    expect(
      classifyFinalStatus({ verdict: "CONFLICTING_EVIDENCE" } as any, {
        decision: { level: "not-required", reasons: [] },
        ran: false,
        challenge: null,
        comparison: null,
      }),
    ).toBe("CONFLICTING");
  });

  it("[FindCallees independence] the go-to-definition challenge corroborates constructor calls too, not just method calls", async () => {
    // Regression test for a real bug caught only by running this against a
    // real repository: the challenge's AST walk originally only visited
    // ts.CallExpression, so `new FastRunner()` (a NewExpression) was
    // invisible to it — every constructor call showed up as "only in
    // primary", misclassifying a coverage gap in the challenge as a genuine
    // CONFLICTING disagreement. Fixed in challenge.ts's walkBodyForCalls.
    const engine = new Engine(REPO_A);
    // Force verification to run regardless of this query's own scoped risk
    // (the FindCallees risk-scoping fix in docs/verification-layer.md
    // means a query whose own body has no dynamic-dispatch/reflection site
    // no longer auto-triggers verification just because *some* file
    // elsewhere in the repo does — see find-callees.ts's `risk()`). This
    // test's actual subject is the go-to-definition challenge's coverage of
    // NewExpression, which needs the challenge to run at all.
    const out = await engine.findCallees("useFast", { criticality: "high" });
    expect(out.result.confirmed.some((f) => f.calleeName === "FastRunner")).toBe(true); // the `new FastRunner()` finding
    expect(out.verification.ran).toBe(true);
    expect(out.verification.comparison).not.toBeNull();
    expect(out.verification.comparison!.onlyInPrimary).toEqual([]);
    expect(out.verification.comparison!.outcome).toBe("CONFIRMED");
  }, 30000);
});
