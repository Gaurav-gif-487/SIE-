/**
 * Rough token estimate: 4 characters per token. Labelled as an estimate
 * everywhere it's surfaced — this is a budgeting heuristic, not a real
 * tokenizer count, and callers must not present it as exact.
 *
 * Factored out of reasoning/context.ts so every budget-aware trimmer
 * (FindCallers context packs, RepoOverview) shares one definition instead
 * of drifting apart.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
