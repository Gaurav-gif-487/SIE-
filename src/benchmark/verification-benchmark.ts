/**
 * Verification-layer benchmark.
 *
 * Measures, across the labelled fixture repositories:
 *   - verification frequency (share of queries the policy actually challenges)
 *   - verification latency (challenge.costMs)
 *   - accuracy before/after verification, against the same independent hand
 *     labels `groundtruth.test.ts` already uses
 *   - false-positive verification rate: challenge reports CONFLICTING/
 *     CONTRADICTED for a primary result that hand labels say is correct
 *   - false-negative verification rate: see the note printed at the end —
 *     this cannot be honestly measured on these fixtures (explained below),
 *     and this script says so instead of printing a fabricated number.
 *
 * Run with: npx tsx src/benchmark/verification-benchmark.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../engine/engine.js";
import { loadLabelFile, manualOracle } from "../groundtruth/oracles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPOS = ["repo-a", "repo-b"] as const;

function rootFor(name: string): string {
  return path.resolve(__dirname, "../../tests/fixtures", name);
}
function labelsFor(name: string) {
  return loadLabelFile(path.resolve(__dirname, "../../tests/groundtruth", `${name}.labels.json`));
}

async function main(): Promise<void> {
  let queries = 0;
  let verified = 0;
  const latenciesMs: number[] = [];
  let falsePositiveVerifications = 0; // challenge disagreed but primary was actually correct
  let precisionRecallSum = 0;
  let precisionRecallCount = 0;
  let additionalCostMs = 0;
  let baselineCostMs = 0;

  for (const name of REPOS) {
    const labels = labelsFor(name);
    for (const target of labels.targets) {
      queries += 1;
      const engine = new Engine(rootFor(name));
      const out = await engine.findCallers(target.symbol, { criticality: "normal" });
      baselineCostMs += out.totalCost.wallClockMs;

      const truth = manualOracle(labels, target.symbol)!.groundTruth;
      const got = [...new Set([...out.result.confirmed, ...out.result.possible].map((c) => `${c.callSite.file}:${c.callSite.line}`))];
      const falsePositives = got.filter((s) => !truth.includes(s));
      const falseNegatives = truth.filter((s) => !got.includes(s));
      const primaryCorrect = falsePositives.length === 0 && falseNegatives.length === 0;
      precisionRecallSum += primaryCorrect ? 1 : 0;
      precisionRecallCount += 1;

      if (out.verification.ran) {
        verified += 1;
        if (out.verification.challenge) {
          latenciesMs.push(out.verification.challenge.costMs);
          additionalCostMs += out.verification.challenge.costMs;
        }
        const cmp = out.verification.comparison;
        if (cmp && (cmp.outcome === "CONFLICTING" || cmp.outcome === "CONTRADICTED") && primaryCorrect) {
          falsePositiveVerifications += 1;
        }
      }
    }
  }

  const accuracyBefore = precisionRecallSum / precisionRecallCount;
  // The verification layer never rewrites `result` (see "no false callers"
  // test) — it only attaches a classification. So "accuracy after" measured
  // the same way (does `result` match hand labels?) is identical to
  // "accuracy before" by construction. What verification actually changes is
  // whether a wrong answer could be labelled RESOLVED — measured separately
  // by the false-positive/negative rates below, not by this number.
  const accuracyAfter = accuracyBefore;

  console.log(`queries: ${queries}`);
  console.log(`verification frequency: ${verified}/${queries} (${((verified / queries) * 100).toFixed(1)}%)`);
  console.log(
    `verification latency (ms): ${latenciesMs.length === 0 ? "n/a (never ran)" : `mean=${(latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length).toFixed(1)} max=${Math.max(...latenciesMs).toFixed(1)}`}`,
  );
  console.log(`accuracy before verification (primary exact-match rate vs. hand labels): ${(accuracyBefore * 100).toFixed(1)}%`);
  console.log(`accuracy after verification (result is unchanged by design): ${(accuracyAfter * 100).toFixed(1)}%`);
  console.log(`false-positive verifications (flagged disagreement despite a correct primary answer): ${falsePositiveVerifications}`);
  console.log(
    `false-negative verifications: NOT MEASURABLE on these fixtures — the primary path already has a 0% error ` +
      `rate against hand labels here (see groundtruth.test.ts), so there is no real primary error for the ` +
      `challenge to fail to catch. Measuring this honestly requires a fixture with a deliberately injected ` +
      `primary-path bug, which does not exist in this repository; do not report a number for it without one.`,
  );
  console.log(`baseline (primary-only) cost: ${baselineCostMs.toFixed(1)}ms total`);
  console.log(`additional cost from verification: ${additionalCostMs.toFixed(1)}ms total (${queries === 0 ? "n/a" : (additionalCostMs / queries).toFixed(1)}ms/query average, including not-verified queries at 0ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
