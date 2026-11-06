import fs from "node:fs";
import path from "node:path";
import { Entity } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";

/**
 * Search hierarchy:
 *   1. canonical entity lookup
 *   2. symbol / reference lookup
 *   3. structural graph traversal
 *   4. lexical BM25 discovery
 *   5. vector retrieval  -> UNSUPPORTED (no embedding model is shipped; the
 *      engine says so rather than pretending to be semantic)
 *   6. LLM interpretation -> reasoning layer, only over established evidence
 */

export type SearchTier =
  | "canonical-entity"
  | "symbol-lookup"
  | "graph-traversal"
  | "lexical-bm25"
  | "vector"
  | "llm";

export interface SearchHit {
  tier: SearchTier;
  entityId: string | null;
  file: string;
  line: number;
  text: string;
  score: number | null;
}

export interface SearchOutcome {
  tierUsed: SearchTier;
  hits: SearchHit[];
  unsupportedTiers: { tier: SearchTier; reason: string }[];
}

function tokenize(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** Real BM25 over the repository's source files. */
export class Bm25Index {
  private docs: { file: string; lines: string[]; tf: Map<string, number>; length: number }[] = [];
  private df = new Map<string, number>();

  constructor(root: string, files: string[]) {
    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const relPath = path.relative(root, file).split(path.sep).join("/");
      const tokens = tokenize(content);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ file: relPath, lines: content.split("\n"), tf, length: tokens.length });
    }
  }

  get size(): number {
    return this.docs.length;
  }

  search(query: string, limit = 20): SearchHit[] {
    const qTokens = tokenize(query);
    const avgdl = this.docs.reduce((a, d) => a + d.length, 0) / Math.max(1, this.docs.length);
    const k1 = 1.2;
    const b = 0.75;
    const scored: SearchHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const t of qTokens) {
        const f = doc.tf.get(t) ?? 0;
        if (f === 0) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avgdl)));
      }
      if (score <= 0) continue;
      const lineIdx = doc.lines.findIndex((l) => qTokens.some((t) => l.toLowerCase().includes(t)));
      scored.push({
        tier: "lexical-bm25",
        entityId: null,
        file: doc.file,
        line: lineIdx >= 0 ? lineIdx + 1 : 1,
        text: (lineIdx >= 0 ? doc.lines[lineIdx]! : "").trim().slice(0, 200),
        score,
      });
    }
    return scored.sort((a, b2) => (b2.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }
}

export function search(
  store: KnowledgeStore,
  query: string,
  options: { bm25?: Bm25Index } = {},
): SearchOutcome {
  const unsupportedTiers = [
    {
      tier: "vector" as SearchTier,
      reason: "no embedding model is bundled; vector retrieval is UNSUPPORTED rather than approximated",
    },
  ];

  const exact = store.findEntitiesByName(query).filter((e) => e.location);
  if (exact.length > 0) {
    return {
      tierUsed: "canonical-entity",
      hits: exact.map(toHit("canonical-entity")),
      unsupportedTiers,
    };
  }

  const partial = store
    .allEntities()
    .filter((e) => e.location && e.name.toLowerCase().includes(query.toLowerCase()));
  if (partial.length > 0) {
    return { tierUsed: "symbol-lookup", hits: partial.slice(0, 50).map(toHit("symbol-lookup")), unsupportedTiers };
  }

  if (options.bm25 && options.bm25.size > 0) {
    const hits = options.bm25.search(query);
    if (hits.length > 0) return { tierUsed: "lexical-bm25", hits, unsupportedTiers };
  }

  return { tierUsed: "lexical-bm25", hits: [], unsupportedTiers };
}

function toHit(tier: SearchTier) {
  return (e: Entity): SearchHit => ({
    tier,
    entityId: e.id,
    file: e.location!.file,
    line: e.location!.line,
    text: `${e.kind} ${e.attributes.container ? `${e.attributes.container}.` : ""}${e.name}`,
    score: null,
  });
}
