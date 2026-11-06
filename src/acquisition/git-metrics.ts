import { execFileSync } from "node:child_process";
import { EvidenceStatus, Resolution, entityId } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { Counters } from "../cost/measure.js";

/**
 * Git knowledge beyond the raw commit list: churn, recency, authors, hotspots
 * and change coupling, plus per-range blame. Every number is derived from real
 * `git` output; when git is unavailable the caller gets `available: false`.
 */

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export interface FileMetrics {
  file: string;
  commits: number;
  authors: number;
  lastCommitISO: string | null;
  daysSinceLastChange: number | null;
  lines: number;
  /** commits x lines: the standard churn-times-size hotspot proxy */
  hotspotScore: number;
}

export interface GitMetricsResult {
  available: boolean;
  reason?: string;
  filesMeasured: number;
  couplingPairs: number;
  metrics: FileMetrics[];
}

export function acquireGitMetrics(
  root: string,
  store: KnowledgeStore,
  counters: Counters,
  options: { maxCommits?: number; minCoupling?: number } = {},
): GitMetricsResult {
  const maxCommits = options.maxCommits ?? 500;
  const minCoupling = options.minCoupling ?? 2;
  const log = git(root, [
    "log",
    `-n${maxCommits}`,
    "--name-only",
    "--pretty=format:%x01%H%x00%an%x00%aI",
  ]);
  if (log === null) {
    store.addUnknown({
      kind: "no-git-data",
      location: null,
      detail: "git metrics unavailable: not a git repository or git is not installed",
    });
    return { available: false, reason: "git-unavailable", filesMeasured: 0, couplingPairs: 0, metrics: [] };
  }

  const perFile = new Map<string, { commits: number; authors: Set<string>; last: string | null }>();
  const coupling = new Map<string, number>();
  const now = Date.now();

  for (const block of log.split("\x01")) {
    if (!block.trim()) continue;
    const [header, ...rest] = block.split("\n");
    const [, author, date] = (header ?? "").split("\0");
    const files = rest.filter((f) => f.trim().length > 0);
    for (const file of files) {
      const entry = perFile.get(file) ?? { commits: 0, authors: new Set<string>(), last: null };
      entry.commits += 1;
      if (author) entry.authors.add(author);
      if (date && (entry.last === null || date > entry.last)) entry.last = date;
      perFile.set(file, entry);
    }
    const known = files.filter((f) => store.hasEntity(entityId("File", f))).sort();
    if (known.length > 1 && known.length <= 30) {
      for (let i = 0; i < known.length; i += 1) {
        for (let j = i + 1; j < known.length; j += 1) {
          const key = `${known[i]}\u0000${known[j]}`;
          coupling.set(key, (coupling.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const metrics: FileMetrics[] = [];
  for (const [file, entry] of perFile) {
    const fileId = entityId("File", file);
    const fileEntity = store.getEntity(fileId);
    if (!fileEntity) continue;
    const lines = Number(fileEntity.attributes.lines ?? 0);
    const lastMs = entry.last ? Date.parse(entry.last) : NaN;
    const metric: FileMetrics = {
      file,
      commits: entry.commits,
      authors: entry.authors.size,
      lastCommitISO: entry.last,
      daysSinceLastChange: Number.isFinite(lastMs) ? Math.floor((now - lastMs) / 86_400_000) : null,
      lines,
      hotspotScore: entry.commits * lines,
    };
    metrics.push(metric);
    fileEntity.attributes.commits = metric.commits;
    fileEntity.attributes.authors = metric.authors;
    fileEntity.attributes.lastCommitISO = metric.lastCommitISO;
    fileEntity.attributes.hotspotScore = metric.hotspotScore;
    store.addEvidence({
      fact: `${file} changed in ${metric.commits} of the last ${maxCommits} commits by ${metric.authors} author(s), last on ${metric.lastCommitISO}`,
      source: "git log --name-only",
      sourceType: "git",
      location: { file, line: 1, column: 1 },
      revision: store.revision,
      derivation: "commit-file-aggregation",
      status: EvidenceStatus.RESOLVED,
      producedBy: "AnalyzeGitMetrics",
      supports: [fileId],
    });
    counters.filesProcessed += 1;
  }

  let couplingPairs = 0;
  for (const [key, count] of coupling) {
    if (count < minCoupling) continue;
    const [a, b] = key.split("\u0000") as [string, string];
    const relation = store.putRelation({
      kind: "COUPLED_WITH",
      from: entityId("File", a),
      to: entityId("File", b),
      resolution: Resolution.EXACT,
      location: { file: a, line: 1, column: 1 },
      attributes: { coChanges: count },
    });
    couplingPairs += 1;
    store.addEvidence({
      fact: `${a} and ${b} changed together in ${count} commits`,
      source: "git log --name-only",
      sourceType: "git",
      location: { file: a, line: 1, column: 1 },
      revision: store.revision,
      derivation: "co-change-count",
      status: EvidenceStatus.RESOLVED,
      producedBy: "AnalyzeGitMetrics",
      supports: [relation.id],
    });
  }

  metrics.sort((x, y) => y.hotspotScore - x.hotspotScore);
  return { available: true, filesMeasured: metrics.length, couplingPairs, metrics };
}

export interface BlameLine {
  sha: string;
  author: string;
  dateISO: string;
  line: number;
  summary: string;
}

/**
 * `git blame -L` over a symbol's line range. Returns null when git or the file
 * is unavailable — never a fabricated author.
 */
export function blameRange(root: string, file: string, startLine: number, endLine: number): BlameLine[] | null {
  const out = git(root, ["blame", "--line-porcelain", "-L", `${startLine},${endLine}`, "--", file]);
  if (out === null) return null;
  const lines: BlameLine[] = [];
  let current: Partial<BlameLine> = {};
  for (const raw of out.split("\n")) {
    const shaMatch = /^([0-9a-f]{20,40})\s+\d+\s+(\d+)/.exec(raw);
    if (shaMatch) {
      current = { sha: shaMatch[1]!, line: Number(shaMatch[2]) };
      continue;
    }
    if (raw.startsWith("author ")) current.author = raw.slice(7);
    else if (raw.startsWith("author-time ")) current.dateISO = new Date(Number(raw.slice(12)) * 1000).toISOString();
    else if (raw.startsWith("summary ")) current.summary = raw.slice(8);
    else if (raw.startsWith("\t")) {
      if (current.sha && current.author && current.dateISO !== undefined) {
        lines.push({
          sha: current.sha,
          author: current.author,
          dateISO: current.dateISO,
          line: current.line ?? 0,
          summary: current.summary ?? "",
        });
      }
      current = {};
    }
  }
  return lines;
}
