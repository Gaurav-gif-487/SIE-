/**
 * Test blindness detector.
 *
 * Detects code modification followed by task completion without running relevant tests.
 * Exposes evidence event IDs.
 */

import type { TrajectoryEvent, DetectorSignal } from "../types.js";
import type { Detector } from "./types.js";

export class TestBlindnessDetector implements Detector {
  readonly signalType = "test_blindness";
  readonly version = "1.0.0";

  detect(events: TrajectoryEvent[]): DetectorSignal[] {
    const signals: DetectorSignal[] = [];

    const modificationEvents = events.filter((e) => e.event_type === "file_modified" || e.event_type === "file_created");
    const testEvents = events.filter((e) => e.event_type === "test_started" || e.event_type === "test_finished");

    if (modificationEvents.length > 0 && testEvents.length === 0) {
      const evidence = modificationEvents.map((e) => e.event_id);
      signals.push({
        signal: this.signalType,
        severity: modificationEvents.length > 3 ? "high" : "medium",
        confidence: 0.9,
        evidence,
        detected_at: new Date().toISOString(),
        detector_version: this.version,
      });
    }

    return signals;
  }
}
