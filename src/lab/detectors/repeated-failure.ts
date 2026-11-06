/**
 * Repeated failure detector.
 *
 * Detects repeated failed commands or tests without meaningful repository state change between attempts.
 */

import type { TrajectoryEvent, DetectorSignal } from "../types.js";
import type { Detector } from "./types.js";

export class RepeatedFailureDetector implements Detector {
  readonly signalType = "repeated_failure";
  readonly version = "1.0.0";

  detect(events: TrajectoryEvent[]): DetectorSignal[] {
    const signals: DetectorSignal[] = [];

    const failureEvents: TrajectoryEvent[] = [];
    let stateChangesSinceFailure = 0;

    for (const e of events) {
      if (e.event_type === "file_modified" || e.event_type === "file_created") {
        stateChangesSinceFailure++;
      }

      if (
        e.event_type === "tool_failed" ||
        (e.event_type === "test_finished" && (e.payload?.["success"] === false || (e.payload?.["failed"] as number) > 0))
      ) {
        if (stateChangesSinceFailure === 0 && failureEvents.length > 0) {
          failureEvents.push(e);
        } else if (failureEvents.length === 0) {
          failureEvents.push(e);
          stateChangesSinceFailure = 0;
        }
      }
    }

    if (failureEvents.length >= 2) {
      signals.push({
        signal: this.signalType,
        severity: failureEvents.length >= 4 ? "high" : "medium",
        confidence: 0.85,
        evidence: failureEvents.map((e) => e.event_id),
        detected_at: new Date().toISOString(),
        detector_version: this.version,
      });
    }

    return signals;
  }
}
