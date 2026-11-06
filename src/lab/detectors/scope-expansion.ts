/**
 * Scope expansion detector.
 *
 * Compares changed files against expected task-relevant files.
 * Flags modifications to files outside the defined task scope.
 */

import type { TrajectoryEvent, DetectorSignal } from "../types.js";
import type { Detector } from "./types.js";

export class ScopeExpansionDetector implements Detector {
  readonly signalType = "scope_expansion";
  readonly version = "1.0.0";

  detect(events: TrajectoryEvent[], taskRelevantFiles: string[] = []): DetectorSignal[] {
    const signals: DetectorSignal[] = [];
    if (taskRelevantFiles.length === 0) return signals;

    const normRelevant = new Set(taskRelevantFiles.map((f) => f.replace(/\\/g, "/")));

    const outOfScopeEvents: TrajectoryEvent[] = [];
    for (const e of events) {
      if ((e.event_type === "file_modified" || e.event_type === "file_created" || e.event_type === "file_deleted") && e.path) {
        const normPath = e.path.replace(/\\/g, "/");
        if (!normRelevant.has(normPath)) {
          outOfScopeEvents.push(e);
        }
      }
    }

    if (outOfScopeEvents.length > 0) {
      const evidence = outOfScopeEvents.map((e) => e.event_id);
      signals.push({
        signal: this.signalType,
        severity: outOfScopeEvents.length >= 3 ? "high" : "medium",
        confidence: 0.88,
        evidence,
        detected_at: new Date().toISOString(),
        detector_version: this.version,
      });
    }

    return signals;
  }
}
