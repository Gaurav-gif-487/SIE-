/**
 * Retry loop detector.
 *
 * Detects repeated attempts involving similar commands, files, or errors.
 * Exposes evidence event IDs.
 */

import type { TrajectoryEvent, DetectorSignal, SignalSeverity } from "../types.js";
import type { Detector } from "./types.js";

export class RetryLoopDetector implements Detector {
  readonly signalType = "retry_loop";
  readonly version = "1.0.0";

  detect(events: TrajectoryEvent[]): DetectorSignal[] {
    const signals: DetectorSignal[] = [];

    // Track command and test attempts per command/path
    const failedAttempts: Array<{ eventId: string; command?: string; path?: string; timestamp: string }> = [];

    for (const event of events) {
      if (
        (event.event_type === "tool_failed" ||
          (event.event_type === "test_finished" && (event.payload?.["success"] === false || (event.payload?.["failed"] as number) > 0)) ||
          (event.event_type === "command_finished" && (event.payload?.["exit_code"] as number) !== 0))
      ) {
        failedAttempts.push({
          eventId: event.event_id,
          command: event.command,
          path: event.path,
          timestamp: event.timestamp,
        });
      }
    }

    if (failedAttempts.length >= 2) {
      const evidence = failedAttempts.map((a) => a.eventId);
      const count = failedAttempts.length;

      let severity: SignalSeverity = "low";
      let confidence = 0.75;

      if (count >= 5) {
        severity = "high";
        confidence = 0.95;
      } else if (count >= 3) {
        severity = "medium";
        confidence = 0.85;
      }

      signals.push({
        signal: this.signalType,
        severity,
        confidence,
        evidence,
        detected_at: new Date().toISOString(),
        detector_version: this.version,
      });
    }

    return signals;
  }
}
