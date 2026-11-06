import fs from "node:fs";
import path from "node:path";
import { Entity, EvidenceStatus, Resolution, entityId } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { Counters } from "../cost/measure.js";

/**
 * Runtime intelligence.
 *
 * Reads artifacts that a real run produced: LCOV coverage, Vitest/Jest JSON
 * reporter output and stack traces. Nothing here synthesizes execution: when a
 * file is absent or unparsable the corresponding unknown region is recorded and
 * the caller receives `available: false`.
 */

/** Innermost Function/Method entity whose span contains `line`, if any. */
export function symbolAtLine(store: KnowledgeStore, file: string, line: number): Entity | null {
  let best: Entity | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const e of store.allEntities()) {
    if (e.kind !== "Function" && e.kind !== "Method") continue;
    const loc = e.location;
    if (!loc || loc.file !== file) continue;
    const end = loc.endLine ?? loc.line;
    if (line < loc.line || line > end) continue;
    const span = end - loc.line;
    if (span < bestSpan) {
      best = e;
      bestSpan = span;
    }
  }
  return best;
}

function toRelative(root: string, file: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join("/");
}

export interface LcovResult {
  available: boolean;
  reason?: string;
  files: number;
  coveredLines: number;
  uncoveredLines: number;
  coveredSymbols: number;
}

/**
 * IngestCoverage (LCOV flavour). Parses `SF:` / `DA:<line>,<hits>` records
 * produced by a real test run and attaches Coverage entities to files and to
 * the innermost enclosing symbol.
 */
export function acquireLcov(
  lcovPath: string | null,
  root: string,
  store: KnowledgeStore,
  counters: Counters,
): LcovResult {
  if (!lcovPath || !fs.existsSync(lcovPath)) {
    store.addUnknown({
      kind: "no-coverage-data",
      location: null,
      detail: "no lcov file supplied; line-level execution is UNKNOWN",
    });
    return { available: false, reason: "file-absent", files: 0, coveredLines: 0, uncoveredLines: 0, coveredSymbols: 0 };
  }
  const text = fs.readFileSync(lcovPath, "utf8");
  let currentFile: string | null = null;
  let files = 0;
  let covered = 0;
  let uncovered = 0;
  const coveredSymbols = new Set<string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      currentFile = toRelative(root, line.slice(3));
      if (store.hasEntity(entityId("File", currentFile))) files += 1;
      continue;
    }
    if (line === "end_of_record") {
      currentFile = null;
      continue;
    }
    if (!currentFile || !line.startsWith("DA:")) continue;
    const [lineNoText, hitsText] = line.slice(3).split(",");
    const lineNo = Number(lineNoText);
    const hits = Number(hitsText);
    if (!Number.isFinite(lineNo) || !Number.isFinite(hits)) continue;
    const fileId = entityId("File", currentFile);
    if (!store.hasEntity(fileId)) continue;
    if (hits <= 0) {
      uncovered += 1;
      continue;
    }
    covered += 1;
    const location = { file: currentFile, line: lineNo, column: 1 };
    const coverageId = entityId("Coverage", `${currentFile}:${lineNo}`);
    store.putEntity({
      id: coverageId,
      kind: "Coverage",
      name: `${currentFile}:${lineNo}`,
      location,
      attributes: { hits },
    });
    const owner = symbolAtLine(store, currentFile, lineNo);
    const relation = store.putRelation({
      kind: "COVERS",
      from: coverageId,
      to: owner ? owner.id : fileId,
      resolution: Resolution.EXACT,
      location,
      attributes: { hits, granularity: owner ? "symbol" : "file" },
    });
    if (owner) coveredSymbols.add(owner.id);
    store.addEvidence({
      fact: `${currentFile}:${lineNo} executed ${hits} time(s) in the supplied lcov run`,
      source: lcovPath,
      sourceType: "coverage",
      location,
      revision: store.revision,
      derivation: "lcov-DA-record",
      status: EvidenceStatus.RESOLVED,
      producedBy: "IngestCoverage",
      supports: owner ? [relation.id, owner.id] : [relation.id],
    });
    counters.symbolsProcessed += 1;
  }
  counters.filesProcessed += files;
  return { available: true, files, coveredLines: covered, uncoveredLines: uncovered, coveredSymbols: coveredSymbols.size };
}

export interface TestResultsSummary {
  available: boolean;
  reason?: string;
  format: "vitest-json" | "jest-json" | null;
  tests: number;
  passed: number;
  failed: number;
  failuresMapped: number;
}

interface JsonAssertion {
  title?: string;
  fullName?: string;
  status?: string;
  failureMessages?: string[];
  duration?: number | null;
}

interface JsonTestFile {
  name?: string;
  testFilePath?: string;
  assertionResults?: JsonAssertion[];
  status?: string;
}

/**
 * IngestTestResults. Accepts the JSON reporter output shared by Vitest and Jest
 * (`{ testResults: [{ name, assertionResults: [...] }] }`). Test entities are
 * created for real reported tests only; failure stack frames are mapped back to
 * files, lines and enclosing symbols.
 */
export function acquireTestResults(
  resultsPath: string | null,
  root: string,
  store: KnowledgeStore,
  counters: Counters,
): TestResultsSummary {
  if (!resultsPath || !fs.existsSync(resultsPath)) {
    store.addUnknown({
      kind: "no-test-data",
      location: null,
      detail: "no test-results JSON supplied; test outcomes are UNKNOWN",
    });
    return { available: false, reason: "file-absent", format: null, tests: 0, passed: 0, failed: 0, failuresMapped: 0 };
  }
  let parsed: { testResults?: JsonTestFile[] };
  try {
    parsed = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as { testResults?: JsonTestFile[] };
  } catch {
    store.addUnknown({ kind: "no-test-data", location: null, detail: `test results ${resultsPath} unparsable` });
    return { available: false, reason: "unparsable", format: null, tests: 0, passed: 0, failed: 0, failuresMapped: 0 };
  }
  const testFiles = parsed.testResults;
  if (!Array.isArray(testFiles)) {
    store.addUnknown({
      kind: "no-test-data",
      location: null,
      detail: `test results ${resultsPath} has no testResults array (unsupported reporter format)`,
    });
    return { available: false, reason: "unsupported-format", format: null, tests: 0, passed: 0, failed: 0, failuresMapped: 0 };
  }
  // Vitest emits `name` as an absolute path; Jest emits `testFilePath` too.
  const format: "vitest-json" | "jest-json" = testFiles.some((t) => t.testFilePath) ? "jest-json" : "vitest-json";

  let tests = 0;
  let passed = 0;
  let failed = 0;
  let failuresMapped = 0;

  for (const tf of testFiles) {
    const filePath = tf.testFilePath ?? tf.name;
    if (!filePath) continue;
    const file = toRelative(root, filePath);
    const fileId = entityId("File", file);
    counters.filesProcessed += 1;
    for (const assertion of tf.assertionResults ?? []) {
      const title = assertion.fullName ?? assertion.title;
      if (!title) continue;
      tests += 1;
      const status = assertion.status ?? "unknown";
      if (status === "passed") passed += 1;
      else if (status === "failed") failed += 1;
      const testId = entityId("Test", `${file}::${title}`);
      const location = { file, line: 1, column: 1 };
      store.putEntity({
        id: testId,
        kind: "Test",
        name: title,
        location,
        attributes: { file, status, durationMs: assertion.duration ?? null },
      });
      if (store.hasEntity(fileId)) {
        store.putRelation({
          kind: "DECLARES",
          from: fileId,
          to: testId,
          resolution: Resolution.EXACT,
          location,
          attributes: {},
        });
      }
      store.addEvidence({
        fact: `test "${title}" (${file}) reported status ${status}`,
        source: resultsPath,
        sourceType: "test-runner",
        location,
        revision: store.revision,
        derivation: `${format}:assertionResult`,
        status: EvidenceStatus.RESOLVED,
        producedBy: "IngestTestResults",
        supports: [testId],
      });
      for (const message of assertion.failureMessages ?? []) {
        for (const frame of parseStackFrames(message, root)) {
          if (!store.hasEntity(entityId("File", frame.file))) continue;
          const owner = symbolAtLine(store, frame.file, frame.line);
          const relation = store.putRelation({
            kind: "TESTS",
            from: testId,
            to: owner ? owner.id : entityId("File", frame.file),
            resolution: owner ? Resolution.EXACT : Resolution.PARTIAL,
            location: frame,
            attributes: { via: "failure-stack-frame" },
          });
          failuresMapped += 1;
          store.addEvidence({
            fact: `failing test "${title}" produced a stack frame at ${frame.file}:${frame.line}`,
            source: resultsPath,
            sourceType: "stack-trace",
            location: frame,
            revision: store.revision,
            derivation: "failure-message-stack-frame",
            status: EvidenceStatus.RESOLVED,
            producedBy: "IngestTestResults",
            supports: owner ? [relation.id, owner.id] : [relation.id],
          });
        }
      }
      counters.symbolsProcessed += 1;
    }
  }
  return { available: true, format, tests, passed, failed, failuresMapped };
}

export interface StackFrame {
  file: string;
  line: number;
  column: number;
  fn?: string;
}

const FRAME_RE = /at\s+(?:([^\s(]+)\s+)?\(?([^\s()]+?):(\d+):(\d+)\)?/g;

/** Parses V8-style `at fn (file:line:col)` frames. Unknown formats yield []. */
export function parseStackFrames(text: string, root: string): StackFrame[] {
  const frames: StackFrame[] = [];
  FRAME_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FRAME_RE.exec(text)) !== null) {
    const [, fn, rawFile, lineText, colText] = match;
    if (!rawFile) continue;
    const cleaned = rawFile.replace(/^file:\/\//, "");
    if (cleaned.includes("node:internal")) continue;
    frames.push({
      file: toRelative(root, cleaned),
      line: Number(lineText),
      column: Number(colText),
      fn: fn && fn !== "Object.<anonymous>" ? fn : undefined,
    });
  }
  return frames;
}

export interface StackTraceResult {
  available: boolean;
  reason?: string;
  frames: number;
  mappedSymbols: number;
}

/**
 * IngestStackTraces. Reads a text file containing one or more real stack traces
 * (crash logs, CI output) and attaches RuntimeEvent entities at the mapped
 * locations. Frames outside the repository are ignored, not guessed.
 */
export function acquireStackTraces(
  tracePath: string | null,
  root: string,
  store: KnowledgeStore,
  counters: Counters,
): StackTraceResult {
  if (!tracePath || !fs.existsSync(tracePath)) {
    store.addUnknown({
      kind: "no-runtime-data",
      location: null,
      detail: "no stack-trace log supplied; observed failure paths are UNKNOWN",
    });
    return { available: false, reason: "file-absent", frames: 0, mappedSymbols: 0 };
  }
  const text = fs.readFileSync(tracePath, "utf8");
  const frames = parseStackFrames(text, root);
  const mapped = new Set<string>();
  for (const frame of frames) {
    const fileId = entityId("File", frame.file);
    if (!store.hasEntity(fileId)) continue;
    const owner = symbolAtLine(store, frame.file, frame.line);
    const eventId = entityId("RuntimeEvent", `stack:${frame.file}:${frame.line}:${frame.column}`);
    store.putEntity({
      id: eventId,
      kind: "RuntimeEvent",
      name: frame.fn ?? `${frame.file}:${frame.line}`,
      location: frame,
      attributes: { kind: "stack-frame", fn: frame.fn ?? null },
    });
    const relation = store.putRelation({
      kind: "EXECUTED_AS",
      from: owner ? owner.id : fileId,
      to: eventId,
      resolution: owner ? Resolution.EXACT : Resolution.PARTIAL,
      location: frame,
      attributes: { via: "stack-trace" },
    });
    if (owner) mapped.add(owner.id);
    store.addEvidence({
      fact: `stack frame observed at ${frame.file}:${frame.line}${owner ? ` inside ${owner.name}` : ""}`,
      source: tracePath,
      sourceType: "stack-trace",
      location: frame,
      revision: store.revision,
      derivation: "v8-stack-frame",
      status: EvidenceStatus.RESOLVED,
      producedBy: "IngestStackTraces",
      supports: owner ? [relation.id, owner.id] : [relation.id],
    });
    counters.symbolsProcessed += 1;
  }
  return { available: true, frames: frames.length, mappedSymbols: mapped.size };
}
