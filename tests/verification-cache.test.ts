import { describe, it, expect } from "vitest";
import path from "node:path";
import { Engine } from "../src/engine/engine.js";
import { QueryCache } from "../src/planning/query-cache.js";

const REPO = path.join(__dirname, "fixtures/repo-a");

describe("verification + query cache interplay", () => {
  it("reuses the verification record on a cache hit instead of re-challenging", async () => {
    const qc = new QueryCache();
    const engine = new Engine(REPO, { cache: false, queryCache: qc, verification: { criticality: "high" } });
    const first = await engine.findCallers("FastRunner.run");
    expect(first.cacheHit).toBe(false);
    expect(first.verification.ran).toBe(true);
    const firstChallengeCost = first.verification.challenge?.costMs;

    const second = await engine.findCallers("FastRunner.run");
    expect(second.cacheHit).toBe(true);
    expect(second.verification.ran).toBe(true);
    // same challenge result reused, not recomputed
    expect(second.verification.challenge?.costMs).toBe(firstChallengeCost);
    expect(second.finalStatus).toBe(first.finalStatus);
  }, 30000);
});
