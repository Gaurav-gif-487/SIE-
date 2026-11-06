/**
 * Detectors registry & suite.
 *
 * Runs all initial deterministic detectors against a trajectory event stream.
 */

import type { TrajectoryEvent, DetectorSignal } from "../types.js";
import type { Detector } from "./types.js";
import { RetryLoopDetector } from "./retry-loop.js";
import { TestBlindnessDetector } from "./test-blindness.js";
import { ScopeExpansionDetector } from "./scope-expansion.js";
import { DuplicateBehaviorDetector } from "./duplicate-behavior.js";
import { RepeatedFailureDetector } from "./repeated-failure.js";

export * from "./types.js";
export * from "./retry-loop.js";
export * from "./test-blindness.js";
export * from "./scope-expansion.js";
export * from "./duplicate-behavior.js";
export * from "./repeated-failure.js";

export class DetectorSuite {
  private readonly detectors: Detector[];

  constructor() {
    this.detectors = [
      new RetryLoopDetector(),
      new TestBlindnessDetector(),
      new ScopeExpansionDetector(),
      new DuplicateBehaviorDetector(),
      new RepeatedFailureDetector(),
    ];
  }

  /**
   * Run all detectors against a trajectory event stream.
   * @param events - Stream of trajectory events
   * @param taskRelevantFiles - Optional list of expected task relevant files
   */
  run(events: TrajectoryEvent[], taskRelevantFiles?: string[]): DetectorSignal[] {
    const allSignals: DetectorSignal[] = [];
    for (const detector of this.detectors) {
      const signals = detector.detect(events, taskRelevantFiles);
      allSignals.push(...signals);
    }
    return allSignals;
  }
}
