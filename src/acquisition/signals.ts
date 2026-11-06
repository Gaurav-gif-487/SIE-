import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { EvidenceStatus, Resolution, entityId } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { Counters } from "../cost/measure.js";

/**
 * AnalyzeGitHistory: real `git log` only. If the repository has no git data the
 * engine records a no-git-data unknown region instead of inventing history.
 */
export function acquireGitHistory(
  root: string,
  store: KnowledgeStore,
  counters: Counters,
  maxCommits = 200,
): { available: boolean; commits: number } {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["-C", root, "log", `-n${maxCommits}`, "--name-only", "--pretty=format:%H%x00%an%x00%aI%x00%s"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    store.addUnknown({
      kind: "no-git-data",
      location: null,
      detail: "git history is unavailable for this repository; CHANGED_BY relations are UNKNOWN",
    });
    return { available: false, commits: 0 };
  }

  let commits = 0;
  const blocks = out.split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    const header = lines[0]!.split("\0");
    if (header.length < 4) continue;
    const [sha, author, date, subject] = header as [string, string, string, string];
    const commitId = entityId("Commit", sha);
    store.putEntity({
      id: commitId,
      kind: "Commit",
      name: sha.slice(0, 8),
      attributes: { author, date, subject },
    });
    commits += 1;
    for (const file of lines.slice(1)) {
      const fileId = entityId("File", file);
      if (!store.hasEntity(fileId)) continue;
      const relation = store.putRelation({
        kind: "CHANGED_BY",
        from: fileId,
        to: commitId,
        resolution: Resolution.EXACT,
        location: { file, line: 1, column: 1 },
        attributes: { date },
      });
      store.addEvidence({
        fact: `${file} was changed by commit ${sha.slice(0, 8)}`,
        source: "git log --name-only",
        sourceType: "git",
        location: { file, line: 1, column: 1 },
        revision: store.revision,
        derivation: "git-commit-file-list",
        status: EvidenceStatus.RESOLVED,
        producedBy: "AnalyzeGitHistory",
        supports: [relation.id, fileId],
      });
      counters.filesProcessed += 1;
    }
  }
  return { available: true, commits };
}

interface IstanbulCoverage {
  [file: string]: {
    path?: string;
    statementMap?: Record<string, { start: { line: number; column: number } }>;
    s?: Record<string, number>;
  };
}

/**
 * IngestCoverage: reads a real istanbul/nyc coverage-final.json. Without a file
 * the engine records no-coverage-data. It never synthesizes coverage.
 */
export function acquireCoverage(
  coveragePath: string | null,
  root: string,
  store: KnowledgeStore,
  counters: Counters,
): { available: boolean; executedLines: number } {
  if (!coveragePath || !fs.existsSync(coveragePath)) {
    store.addUnknown({
      kind: "no-coverage-data",
      location: null,
      detail: "no coverage file supplied; EXECUTED_AS relations are UNKNOWN",
    });
    return { available: false, executedLines: 0 };
  }
  let data: IstanbulCoverage;
  try {
    data = JSON.parse(fs.readFileSync(coveragePath, "utf8")) as IstanbulCoverage;
  } catch {
    store.addUnknown({
      kind: "no-coverage-data",
      location: null,
      detail: `coverage file ${coveragePath} could not be parsed`,
    });
    return { available: false, executedLines: 0 };
  }
  let executed = 0;
  for (const [key, entry] of Object.entries(data)) {
    const abs = entry.path ?? key;
    const file = abs.startsWith(root) ? abs.slice(root.length + 1) : abs;
    const fileId = entityId("File", file);
    if (!store.hasEntity(fileId)) continue;
    for (const [stmtId, count] of Object.entries(entry.s ?? {})) {
      if (count <= 0) continue;
      const start = entry.statementMap?.[stmtId]?.start;
      if (!start) continue;
      executed += 1;
      const eventId = entityId("RuntimeEvent", `${file}:${start.line}`);
      store.putEntity({
        id: eventId,
        kind: "RuntimeEvent",
        name: `executed ${file}:${start.line}`,
        location: { file, line: start.line, column: start.column + 1 },
        attributes: { hits: count },
      });
      const relation = store.putRelation({
        kind: "EXECUTED_AS",
        from: fileId,
        to: eventId,
        resolution: Resolution.EXACT,
        location: { file, line: start.line, column: start.column + 1 },
        attributes: { hits: count },
      });
      store.addEvidence({
        fact: `${file}:${start.line} executed ${count} time(s) under the supplied coverage run`,
        source: coveragePath,
        sourceType: "coverage",
        location: { file, line: start.line, column: start.column + 1 },
        revision: store.revision,
        derivation: "istanbul-statement-map",
        status: EvidenceStatus.RESOLVED,
        producedBy: "IngestCoverage",
        supports: [relation.id],
      });
    }
    counters.filesProcessed += 1;
  }
  return { available: true, executedLines: executed };
}

export interface RuntimeTraceEntry {
  caller?: string;
  callee: string;
  file: string;
  line: number;
}

/**
 * IngestRuntimeTrace: reads a JSON array of observed calls produced by an
 * actual instrumented run. Absent input => no-runtime-data (never fabricated).
 * Runtime evidence that contradicts static evidence is stored as CONFLICTING.
 */
export function acquireRuntimeTrace(
  tracePath: string | null,
  store: KnowledgeStore,
  counters: Counters,
): { available: boolean; events: number; conflicts: number } {
  if (!tracePath || !fs.existsSync(tracePath)) {
    store.addUnknown({
      kind: "no-runtime-data",
      location: null,
      detail: "no runtime trace supplied; dynamic dispatch cannot be confirmed",
    });
    return { available: false, events: 0, conflicts: 0 };
  }
  let entries: RuntimeTraceEntry[];
  try {
    entries = JSON.parse(fs.readFileSync(tracePath, "utf8")) as RuntimeTraceEntry[];
    if (!Array.isArray(entries)) throw new Error("not an array");
  } catch {
    store.addUnknown({ kind: "no-runtime-data", location: null, detail: `trace ${tracePath} unparsable` });
    return { available: false, events: 0, conflicts: 0 };
  }
  let conflicts = 0;
  for (const entry of entries) {
    const location = { file: entry.file, line: entry.line, column: 1 };
    const eventId = entityId("RuntimeEvent", `${entry.file}:${entry.line}:${entry.callee}`);
    store.putEntity({
      id: eventId,
      kind: "RuntimeEvent",
      name: `${entry.caller ?? "<unknown>"} -> ${entry.callee}`,
      location,
      attributes: { callee: entry.callee, caller: entry.caller ?? null },
    });
    // Does a static CALLS relation exist at this location?
    const staticRel = store
      .relationsOfKind("CALLS")
      .find((r) => r.location?.file === entry.file && r.location?.line === entry.line);
    const staticTargetName = staticRel
      ? String(staticRel.attributes.calleeText ?? "").split(".").pop()
      : null;
    const runtimeName = entry.callee.split(".").pop();
    const contradicts = Boolean(staticRel && staticTargetName && runtimeName && staticTargetName !== runtimeName);
    if (contradicts) conflicts += 1;
    const relation = store.putRelation({
      kind: "EXECUTED_AS",
      from: staticRel ? staticRel.id : eventId,
      to: eventId,
      resolution: Resolution.EXACT,
      location,
      attributes: { observed: entry.callee },
    });
    store.addEvidence({
      fact: `runtime observed call to ${entry.callee} at ${entry.file}:${entry.line}`,
      source: tracePath,
      sourceType: "runtime-trace",
      location,
      revision: store.revision,
      derivation: "instrumented-run",
      status: contradicts ? EvidenceStatus.CONFLICTING : EvidenceStatus.RESOLVED,
      producedBy: "IngestRuntimeTrace",
      supports: [relation.id, ...(staticRel ? [staticRel.id] : [])],
    });
    counters.symbolsProcessed += 1;
  }
  return { available: true, events: entries.length, conflicts };
}
