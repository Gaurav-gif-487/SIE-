import fs from "node:fs";
import path from "node:path";
import { formatLocation } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { FindCallersResult, ResidualRisk, Uncertainty } from "../tasks/find-callers.js";
import { estimateTokens } from "./tokens.js";

/**
 * Reasoning layer boundary.
 *
 * The LLM is not the fact engine. This module builds the smallest useful
 * context from *established evidence only*, and refuses to emit a prompt when
 * evidence is insufficient. No LLM call is made here; the engine has no model
 * credentials and will not pretend to have reasoned.
 */

export interface ContextItem {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
  reason: string;
  evidenceIds: string[];
  estimatedTokens: number;
}

export interface ContextPack {
  task: string;
  sufficient: boolean;
  /** included only when sufficient; otherwise the caller must run more analysis */
  items: ContextItem[];
  factSheet: string[];
  openQuestions: string[];
  estimatedTokens: number;
  llmStatus: "NOT_INVOKED_NO_MODEL_CONFIGURED" | "NOT_JUSTIFIED_EVIDENCE_SUFFICIENT" | "INSUFFICIENT_EVIDENCE";
  buildMs: number;
}

function snippet(root: string, file: string, line: number, radius: number): { text: string; start: number; end: number } {
  try {
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    const start = Math.max(1, line - radius);
    const end = Math.min(lines.length, line + radius);
    return { text: lines.slice(start - 1, end).join("\n"), start, end };
  } catch {
    return { text: "", start: line, end: line };
  }
}

export function buildFindCallersContext(
  store: KnowledgeStore,
  result: FindCallersResult,
  uncertainty: Uncertainty,
  risk: ResidualRisk,
  options: { tokenBudget?: number; radius?: number } = {},
): ContextPack {
  const started = process.hrtime.bigint();
  const budget = options.tokenBudget ?? 2000;
  const radius = options.radius ?? 4;

  const factSheet: string[] = [];
  for (const target of result.targets) {
    factSheet.push(
      `TARGET ${target.container ? `${target.container}.` : ""}${target.name} declared at ${formatLocation(target.location)} [evidence: ${store
        .evidenceFor(target.id)
        .map((e) => e.derivation)
        .join(", ")}]`,
    );
  }
  for (const c of result.confirmed) {
    factSheet.push(
      `CONFIRMED CALLER ${c.callerName} at ${formatLocation(c.callSite)} calls ${c.calleeText} [resolution=${c.resolution}]`,
    );
  }
  for (const p of result.possible) {
    factSheet.push(
      `POSSIBLE CALLER ${p.callerName} at ${formatLocation(p.callSite)} (${p.resolution}${p.receiverType ? `, receiver ${p.receiverType}` : ""})`,
    );
  }

  const openQuestions: string[] = [];
  for (const u of result.unresolvedSites) {
    openQuestions.push(`UNRESOLVED CALL SITE ${formatLocation(u.callSite)}: ${u.calleeText} (${u.risk ?? "no static target"})`);
  }
  for (const f of risk.factors) {
    openQuestions.push(`RISK ${f.kind} x${f.count}: ${f.detail}`);
  }
  if (uncertainty.value === null) {
    openQuestions.push(`UNCERTAINTY UNQUANTIFIED: ${uncertainty.explanation}`);
  }

  const insufficient = result.targets.length === 0;
  const items: ContextItem[] = [];
  let tokens = factSheet.concat(openQuestions).reduce((a, l) => a + estimateTokens(l), 0);

  if (!insufficient) {
    // Relevance order: confirmed callers first, then targets, then possible callers.
    const seeds = [
      ...result.confirmed.map((c) => ({ loc: c.callSite, reason: "confirmed call site", ev: c.evidenceIds })),
      ...result.targets.map((t) => ({ loc: t.location, reason: "target declaration", ev: store.evidenceFor(t.id).map((e) => e.id) })),
      ...result.possible.map((p) => ({ loc: p.callSite, reason: `possible call site (${p.resolution})`, ev: p.evidenceIds })),
    ];
    const seen = new Set<string>();
    for (const seed of seeds) {
      const key = `${seed.loc.file}:${seed.loc.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = snippet(store.repositoryRoot, seed.loc.file, seed.loc.line, radius);
      if (!s.text) continue;
      const cost = estimateTokens(s.text);
      if (tokens + cost > budget) break;
      tokens += cost;
      items.push({
        file: seed.loc.file,
        startLine: s.start,
        endLine: s.end,
        snippet: s.text,
        reason: seed.reason,
        evidenceIds: seed.ev,
        estimatedTokens: cost,
      });
    }
  }

  const buildMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    task: `FindCallers(${result.symbol})`,
    sufficient: !insufficient,
    items,
    factSheet,
    openQuestions,
    estimatedTokens: tokens,
    llmStatus: insufficient ? "INSUFFICIENT_EVIDENCE" : "NOT_INVOKED_NO_MODEL_CONFIGURED",
    buildMs,
  };
}
