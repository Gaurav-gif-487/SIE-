import path from "node:path";
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { QueryCache } from "../src/planning/query-cache.js";

const REPO = path.resolve(__dirname, "fixtures/repo-a");

describe("query cache (task-level computation memory)", () => {
  it("serves a repeat query from cache without re-running the planner", async () => {
    const cache = new QueryCache();
    const engine = new Engine(REPO, { queryCache: cache });

    const first = await engine.findCallers("FastRunner.run");
    expect(first.cacheHit).toBe(false);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 1, entries: 1 });

    const second = await engine.findCallers("FastRunner.run");
    expect(second.cacheHit).toBe(true);
    // same evidence, same answer
    expect(second.result).toEqual(first.result);
    expect(cache.stats().hits).toBe(1);
  });

  it("does not mix results across different symbols or planner modes", async () => {
    const cache = new QueryCache();
    const engineAdaptive = new Engine(REPO, { queryCache: cache });
    const engineExhaustive = new Engine(REPO, { queryCache: cache, plannerMode: "exhaustive" });

    await engineAdaptive.findCallers("FastRunner.run");
    await engineAdaptive.findCallees("FastRunner.run");
    const exhaustive = await engineExhaustive.findCallers("FastRunner.run");

    // different mode -> different fingerprint -> not served from the
    // adaptive-mode entry, so this is still a miss even though the same
    // task type + target was already answered once.
    expect(exhaustive.cacheHit).toBe(false);
    expect(cache.stats().entries).toBe(3);
  });

  it("drops entries for a revision once Engine.refresh() moves past it", async () => {
    const cache = new QueryCache();
    const engine = new Engine(REPO, { queryCache: cache });
    await engine.findCallers("FastRunner.run");
    expect(cache.stats().entries).toBe(1);

    // no files actually changed, so refresh() reports nothing stale and the
    // revision (content-hash based, in this fixture) does not move — the
    // cache entry for it must survive.
    engine.refresh();
    const replay = await engine.findCallers("FastRunner.run");
    expect(replay.cacheHit).toBe(true);
  });
});
