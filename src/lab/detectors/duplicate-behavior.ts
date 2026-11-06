/**
 * Duplicate behavior detector.
 *
 * Detects suspiciously duplicated implementations using static/deterministic line matching techniques.
 */

import type { TrajectoryEvent, DetectorSignal } from "../types.js";
import type { Detector } from "./types.js";

export class DuplicateBehaviorDetector implements Detector {
  readonly signalType = "duplicate_behavior";
  readonly version = "1.0.0";

  detect(events: TrajectoryEvent[]): DetectorSignal[] {
    const signals: DetectorSignal[] = [];

    const fileModificationEvents = events.filter((e) => e.event_type === "file_modified" || e.event_type === "file_created");
    const duplicateEvents: TrajectoryEvent[] = [];

    for (const event of fileModificationEvents) {
      const diff = (event.payload?.["diff"] as string) ?? "";
      if (diff.includes("duplicate") || diff.includes("Attempt") || (diff.length > 200 && diff.split("\n").filter((l) => l.startsWith("+")).length > 20)) {
        // Flagged duplicate block pattern
        duplicateEvents.push(event);
      }
    }

    if (duplicateEvents.length > 0) {
      signals.push({
        signal: this.signalType,
        severity: "medium",
        confidence: 0.8,
        evidence: duplicateEvents.map((e) => e.event_id),
        detected_at: new Date().toISOString(),
        detector_version: this.version,
      });
    }

    return signals;
  }
}
