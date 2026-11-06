/**
 * Detector interface & types.
 *
 * Every detector MUST expose its evidence events.
 * It must output:
 *   signal = <type>
 *   severity = 'low' | 'medium' | 'high'
 *   confidence = 0..1
 *   evidence = [event_31, event_34, event_39]
 */

import type { TrajectoryEvent, DetectorSignal } from "../types.js";

export interface Detector {
  readonly signalType: DetectorSignal["signal"];
  readonly version: string;

  /**
   * Analyze trajectory events and return detected signals with evidence IDs.
   * @param events - Trajectory event stream
   * @param taskRelevantFiles - Relevant files defined for the benchmark task (optional context)
   */
  detect(events: TrajectoryEvent[], taskRelevantFiles?: string[]): DetectorSignal[];
}
