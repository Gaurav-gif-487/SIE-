import path from "node:path";
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import {
  agreement,
  languageServiceOracle,
  loadLabelFile,
  manualOracle,
  typeDirectedOracle,
} from "../src/groundtruth/oracles.js";

const REPOS = ["repo-a", "repo-b"] as const;

function labelsFor(name: string) {
  return loadLabelFile(path.resolve(__dirname, "groundtruth", `${name}.labels.json`));
}
function rootFor(name: string) {
  return path.resolve(__dirname, "fixtures", name);
}

describe("ground truth is independent of the engine", () => {
  for (const name of REPOS) {
    it(`${name}: hand labels and the type-directed oracle agree exactly`, () => {
      const labels = labelsFor(name);
      for (const target of labels.targets) {
        const manual = manualOracle(labels, target.symbol)!;
        const typed = typeDirectedOracle(rootFor(name), target.symbol);
        expect(agreement(manual, typed).identical, `${target.symbol}: ${JSON.stringify(agreement(manual, typed))}`).toBe(true);
      }
    });

    it(`${name}: the reference-based oracle is over-inclusive (why we do not use it as truth)`, () => {
      const labels = labelsFor(name);
      let overReports = 0;
      for (const target of labels.targets) {
        const manual = manualOracle(labels, target.symbol)!;
        const ls = languageServiceOracle(rootFor(name), target.symbol);
        const cmp = agreement(manual, ls);
        // findReferences unifies an interface member with every implementation,
        // so it may add sites; it must never *miss* a hand-labelled site.
        expect(cmp.onlyInA, `${target.symbol} missed by findReferences`).toEqual([]);
        overReports += cmp.onlyInB.length;
      }
      expect(overReports).toBeGreaterThan(0);
    });
  }
});

describe("engine accuracy against independent ground truth", () => {
  for (const name of REPOS) {
    it(`${name}: precision and recall are 1.0 on every labelled target`, async () => {
      const labels = labelsFor(name);
      const engine = new Engine(rootFor(name));
      for (const target of labels.targets) {
        const truth = manualOracle(labels, target.symbol)!.groundTruth;
        const out = await engine.findCallers(target.symbol);
        const got = [
          ...new Set(
            [...out.result.confirmed, ...out.result.possible].map(
              (c) => `${c.callSite.file}:${c.callSite.line}`,
            ),
          ),
        ].sort();
        expect(got.filter((s) => !truth.includes(s)), `${target.symbol} false positives`).toEqual([]);
        expect(truth.filter((s) => !got.includes(s)), `${target.symbol} false negatives`).toEqual([]);
      }
    });

    it(`${name}: indirect and dynamic sites are reported as open sites, never as callers`, async () => {
      const labels = labelsFor(name);
      const engine = new Engine(rootFor(name));
      for (const target of labels.targets) {
        const excluded = manualOracle(labels, target.symbol)!.excluded ?? [];
        const dynamic = excluded.filter((e) => e.category === "dynamic").map((e) => e.site);
        if (dynamic.length === 0) continue;
        const out = await engine.findCallers(target.symbol);
        const callers = [...out.result.confirmed, ...out.result.possible].map(
          (c) => `${c.callSite.file}:${c.callSite.line}`,
        );
        const open = out.result.unresolvedSites.map((c) => `${c.callSite.file}:${c.callSite.line}`);
        for (const site of dynamic) {
          expect(callers, `${target.symbol}: ${site} must not be claimed`).not.toContain(site);
          expect(open, `${target.symbol}: ${site} must be an open site`).toContain(site);
        }
      }
    });
  }
});

// ------------------------------------------------------------- FindCallees
interface CalleeLabel {
  symbol: string;
  mayExecute: string[];
  mustExecute: string[];
  openSites?: string[];
}

describe("FindCallees against independent ground truth", () => {
  const labels = JSON.parse(
    require("node:fs").readFileSync(path.resolve(__dirname, "groundtruth/repo-b.labels.json"), "utf8"),
  ) as { calleeTargets: CalleeLabel[] };

  for (const label of labels.calleeTargets) {
    it(`${label.symbol}: reports exactly the bodies that may execute`, async () => {
      const engine = new Engine(rootFor("repo-b"));
      const out = await engine.findCallees(label.symbol);
      const got = [
        ...new Set([...out.result.confirmed, ...out.result.possible].map((c) => c.calleeName)),
      ].sort();
      expect(got).toEqual([...label.mayExecute].sort());
      const confirmed = out.result.confirmed.map((c) => c.calleeName);
      for (const must of label.mustExecute) expect(confirmed).toContain(must);
      const open = out.result.unresolvedSites.map((c) => `${c.callSite.file}:${c.callSite.line}`);
      for (const site of label.openSites ?? []) expect(open).toContain(site);
    });
  }
});
