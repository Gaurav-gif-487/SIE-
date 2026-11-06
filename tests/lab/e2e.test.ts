/**
 * Phase 5 tests: Full End-to-End Integration Test.
 *
 * Validates the complete lab infrastructure lifecycle:
 *   synthetic task → mock agent → trajectory → detector → intervention → outcome → analysis → report
 *
 * Checks:
 * - Trajectory recorded with SHA-256 hash chain
 * - Trajectory verification passes (OBSERVATION_VERIFIED)
 * - Trajectory replay succeeds
 * - Detectors emit signals with concrete evidence IDs
 * - Interventions log responses and delivery
 * - Outcome ground truth evaluated
 * - Statistical analysis computes metrics
 * - JSON and Markdown reports generated with conservative conclusions
 * - Strict SYNTHETIC data label maintained throughout
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExperimentRunner } from "../../src/lab/experiment/runner.js";
import { MockAgentAdapter } from "../../src/lab/adapters/mock-agent.js";
import { verifyTrajectory, replayTrajectory } from "../../src/lab/trajectory/replay.js";
import { DetectorSuite } from "../../src/lab/detectors/index.js";
import { TrajectoryRecorder } from "../../src/lab/trajectory/recorder.js";
import { InterventionEngine } from "../../src/lab/interventions/engine.js";
import { ReportGenerator } from "../../src/lab/analysis/report-generator.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mirror-e2e-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("Full End-to-End Integration Test", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = tmpDir();
  });

  afterEach(() => {
    cleanup(rootDir);
  });

  it("synthetic task → mock agent → trajectory → detector → intervention → outcome → analysis → report", async () => {
    const dataDir = path.join(rootDir, "data");
    const reportsDir = path.join(dataDir, "reports");

    // 1. Run Experiment
    const runner = new ExperimentRunner(rootDir, dataDir);
    const adapter = new MockAgentAdapter({ profile: "retry-prone", stepDelay: 0 });

    const expResult = await runner.runExperiment({
      name: "e2e-full-pipeline",
      tasksCount: 2,
      conditionMode: "treatment",
      adapter,
    });

    expect(expResult.data_label).toBe("SYNTHETIC");
    expect(expResult.execution_mode).toBe("synthetic");
    expect(expResult.task_results.length).toBe(2);

    for (const taskRes of expResult.task_results) {
      // 2. Trajectory verification & replay
      const verification = verifyTrajectory(taskRes.trajectory_path);
      expect(verification.status).toBe("OBSERVATION_VERIFIED");

      const replay = replayTrajectory(taskRes.trajectory_path);
      expect(replay.total_events).toBeGreaterThan(0);

      // 3. Detector execution on recorded trajectory events
      const events = TrajectoryRecorder.readTrajectory(taskRes.trajectory_path);
      const detectorSuite = new DetectorSuite();
      const signals = detectorSuite.run(events);
      expect(signals.length).toBeGreaterThan(0);

      for (const sig of signals) {
        expect(sig.evidence.length).toBeGreaterThan(0);

        // 4. Intervention processing
        const interventionEngine = new InterventionEngine(true);
        const record = await interventionEngine.processSignal(sig, adapter);
        expect(record.delivered).toBe(true);
      }

      // 5. Outcome evaluation verification
      expect(taskRes.outcome.evaluation_method).toBe("automated");
    }

    // 6. Report Generation
    const reportGen = new ReportGenerator(reportsDir);
    const reportOut = reportGen.generateReport(expResult);

    expect(fs.existsSync(reportOut.jsonReportPath)).toBe(true);
    expect(fs.existsSync(reportOut.markdownReportPath)).toBe(true);
    expect(reportOut.summaryText).toContain("Insufficient evidence");

    const mdContent = fs.readFileSync(reportOut.markdownReportPath, "utf8");
    expect(mdContent).toContain("SYNTHETIC");
    expect(mdContent).not.toContain("Agent Mirror is intelligent");
  });
});
