/**
 * Cost model. Every number here is measured at run time. Nothing is hardcoded.
 */
export interface CostRecord {
  analysis: string;
  wallClockMs: number;
  heapUsedDeltaBytes: number;
  filesProcessed: number;
  symbolsProcessed: number;
  llmCalls: number;
  llmTokens: number;
}

export interface Counters {
  filesProcessed: number;
  symbolsProcessed: number;
  llmCalls: number;
  llmTokens: number;
}

export function newCounters(): Counters {
  return { filesProcessed: 0, symbolsProcessed: 0, llmCalls: 0, llmTokens: 0 };
}

export async function measure<T>(
  analysis: string,
  fn: (counters: Counters) => Promise<T> | T,
): Promise<{ value: T; cost: CostRecord }> {
  const counters = newCounters();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = process.hrtime.bigint();
  const value = await fn(counters);
  const end = process.hrtime.bigint();
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    value,
    cost: {
      analysis,
      wallClockMs: Number(end - start) / 1e6,
      heapUsedDeltaBytes: heapAfter - heapBefore,
      filesProcessed: counters.filesProcessed,
      symbolsProcessed: counters.symbolsProcessed,
      llmCalls: counters.llmCalls,
      llmTokens: counters.llmTokens,
    },
  };
}

export function sumCost(records: CostRecord[]): Omit<CostRecord, "analysis"> {
  return records.reduce(
    (acc, r) => ({
      wallClockMs: acc.wallClockMs + r.wallClockMs,
      heapUsedDeltaBytes: acc.heapUsedDeltaBytes + r.heapUsedDeltaBytes,
      filesProcessed: acc.filesProcessed + r.filesProcessed,
      symbolsProcessed: acc.symbolsProcessed + r.symbolsProcessed,
      llmCalls: acc.llmCalls + r.llmCalls,
      llmTokens: acc.llmTokens + r.llmTokens,
    }),
    { wallClockMs: 0, heapUsedDeltaBytes: 0, filesProcessed: 0, symbolsProcessed: 0, llmCalls: 0, llmTokens: 0 },
  );
}
