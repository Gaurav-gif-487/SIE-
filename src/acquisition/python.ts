import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { EntityKind, EvidenceStatus, Resolution, entityId } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { Counters } from "../cost/measure.js";
import { rel } from "./program.js";

/**
 * Python acquisition layer.
 *
 * This is a genuinely separate analyzer from the TypeScript pipeline: it
 * shells out to the system `python3` interpreter's own stdlib `ast` module
 * (see `src/languages/python/extract.py`) rather than reusing any TS/JS
 * parsing infrastructure. It is intentionally NOT wired into the
 * crystallization/planner system in this pass — see the module-level note
 * at the bottom of this file for exactly why and what remains.
 */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "site-packages",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
]);

const EXTRACTOR_PATH = fileURLToPath(new URL("../languages/python/extract.py", import.meta.url));

// A conservative subset of builtins/dunder-methods so obviously-external
// calls aren't reported as UNRESOLVED "candidates for a repo symbol" noise.
// This is a convenience list, not a claim of completeness — anything not
// on it just falls through to the normal name-lookup-then-UNRESOLVED path,
// which is still correct, just noisier.
const PY_BUILTINS = new Set([
  "str", "int", "float", "bool", "list", "dict", "set", "tuple", "frozenset",
  "len", "print", "range", "enumerate", "zip", "map", "filter", "sorted",
  "reversed", "isinstance", "issubclass", "getattr", "setattr", "hasattr",
  "super", "open", "type", "repr", "format", "iter", "next", "abs", "min",
  "max", "sum", "any", "all", "callable", "vars", "dir", "id", "hash",
]);

export interface PythonProgramHandle {
  root: string;
  /** absolute paths of .py files under root, node_modules/.venv/etc excluded */
  sourceFiles: string[];
}

export function listPythonFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

export function loadPythonProgram(root: string, files?: string[]): PythonProgramHandle {
  return { root, sourceFiles: files ?? listPythonFiles(root) };
}

// ---------------------------------------------------------- extractor I/O

interface RawImport {
  kind: "import" | "from";
  module: string | null;
  name: string | null;
  asname: string | null;
  level: number;
  line: number;
  col: number;
}

interface RawFunction {
  name: string;
  qualifiedName: string;
  line: number;
  col: number;
  endLine: number;
  isAsync: boolean;
  isMethod: boolean;
  enclosingClass: string | null;
  params: string[];
  decorators: string[];
}

interface RawClass {
  name: string;
  qualifiedName: string;
  line: number;
  col: number;
  endLine: number;
  bases: string[];
  enclosingClass: string | null;
}

interface RawCall {
  callee: string | null;
  isAttribute: boolean;
  receiver: string | null;
  caller: string | null;
  line: number;
  col: number;
}

export interface RawFile {
  file: string;
  module: string;
  lines: number;
  imports: RawImport[];
  functions: RawFunction[];
  classes: RawClass[];
  calls: RawCall[];
}

export interface ExtractorOutput {
  files: RawFile[];
  errors: { file: string | null; error: string }[];
}

/** Batch size per subprocess invocation, to keep argv length sane on large repos. */
const BATCH_SIZE = 200;

export function runExtractor(root: string, files: string[]): ExtractorOutput {
  const merged: ExtractorOutput = { files: [], errors: [] };
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    let stdout: string;
    try {
      stdout = execFileSync("python3", [EXTRACTOR_PATH, root, ...batch], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      merged.errors.push({ file: null, error: `python3 extractor failed: ${message}` });
      continue;
    }
    try {
      const parsed = JSON.parse(stdout) as ExtractorOutput;
      merged.files.push(...parsed.files);
      merged.errors.push(...parsed.errors);
    } catch {
      merged.errors.push({ file: null, error: "extractor produced non-JSON output" });
    }
  }
  return merged;
}

function fileHash(absPath: string): string | null {
  try {
    return createHash("sha1").update(fs.readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- acquisition

/**
 * ParsePythonSource: Repository -> .py files + modules.
 * Mirrors `acquireFilesAndModules` in spirit; a distinct function because
 * the source of truth (python3 ast, not ts.SourceFile) is different.
 */
export function acquirePythonFilesAndModules(
  handle: PythonProgramHandle,
  store: KnowledgeStore,
  counters: Counters,
): ExtractorOutput {
  const root = handle.root;
  store.putEntity({
    id: entityId("Repository", rel(root, root) || "."),
    kind: "Repository",
    name: root,
    attributes: {},
  });

  const extracted = runExtractor(root, handle.sourceFiles);
  counters.filesProcessed += extracted.files.length;

  for (const err of extracted.errors) {
    store.addUnknown({
      kind: "unparsed-file",
      location: err.file ? { file: err.file, line: 1, column: 1 } : null,
      detail: `python3 ast could not parse this file: ${err.error}`,
    });
  }

  for (const f of extracted.files) {
    const abs = path.join(root, f.file);
    const fileEntity = store.putEntity({
      id: entityId("File", f.file),
      kind: "File",
      name: f.file,
      location: { file: f.file, line: 1, column: 1 },
      attributes: { lines: f.lines, language: "python" },
    });
    const hash = fileHash(abs);
    if (hash) store.recordFileHash(f.file, hash);

    const moduleEntity = store.putEntity({
      id: entityId("Module", `py:${f.module}`),
      kind: "Module",
      name: f.module,
      location: { file: f.file, line: 1, column: 1 },
      attributes: { language: "python" },
    });

    store.addEvidence({
      fact: `${f.file} exists and parses as Python (module ${f.module})`,
      source: "python3 ast.parse",
      sourceType: "python-ast",
      location: { file: f.file, line: 1, column: 1 },
      revision: store.revision,
      derivation: "python-ast-file-parsed",
      status: EvidenceStatus.RESOLVED,
      producedBy: "ParsePythonSource",
      supports: [fileEntity.id, moduleEntity.id],
    });
  }

  return extracted;
}

/**
 * ResolvePythonSymbols: Module -> Function/Method/Class declarations, plus
 * DECLARES edges. Also records IMPORTS edges, resolved only against modules
 * this same acquisition pass discovered in-repo (no sys.path emulation —
 * anything not matched in-repo is recorded UNRESOLVED with `external: true`,
 * never guessed).
 */
export function acquirePythonSymbols(
  extracted: ExtractorOutput,
  store: KnowledgeStore,
  counters: Counters,
): Map<string, string[]> {
  // module dotted name -> Module entity id, for import + call target resolution
  const moduleByDotted = new Map<string, string>();
  for (const f of extracted.files) moduleByDotted.set(f.module, entityId("Module", `py:${f.module}`));

  // qualified name (per file) -> entity id, for call resolution
  const byQualifiedName = new Map<string, string[]>();
  const addCandidate = (name: string, id: string) => {
    const list = byQualifiedName.get(name) ?? [];
    // qualifiedName === name for any top-level (non-nested) declaration, so
    // callers that register both must not double-count the same entity.
    if (!list.includes(id)) list.push(id);
    byQualifiedName.set(name, list);
  };

  for (const f of extracted.files) {
    const moduleId = entityId("Module", `py:${f.module}`);

    for (const cls of f.classes) {
      const classId = entityId("Class", `${f.file}::${cls.qualifiedName}`);
      store.putEntity({
        id: classId,
        kind: "Class",
        name: cls.name,
        location: { file: f.file, line: cls.line, column: cls.col, endLine: cls.endLine },
        attributes: { language: "python", bases: cls.bases.join(",") || null },
      });
      store.putRelation({
        kind: "DECLARES",
        from: moduleId,
        to: classId,
        resolution: Resolution.EXACT,
        location: { file: f.file, line: cls.line, column: cls.col },
        attributes: {},
      });
      addCandidate(cls.name, classId);
      addCandidate(cls.qualifiedName, classId);
      counters.symbolsProcessed += 1;
    }

    for (const fn of f.functions) {
      const kind: EntityKind = fn.isMethod ? "Method" : "Function";
      const symId = entityId(kind, `${f.file}::${fn.qualifiedName}`);
      store.putEntity({
        id: symId,
        kind,
        name: fn.name,
        location: { file: f.file, line: fn.line, column: fn.col, endLine: fn.endLine },
        attributes: {
          language: "python",
          // mirrors `container` on TS declarations (see acquisition/symbols.ts):
          // the enclosing class name for a method, null for a module-level function.
          container: fn.enclosingClass ?? null,
          async: fn.isAsync,
          params: fn.params.join(",") || null,
          decorators: fn.decorators.join(",") || null,
        },
      });
      // DECLARES from the enclosing class if this is a method, else the module
      const declaredFrom = fn.isMethod
        ? entityId("Class", `${f.file}::${fn.enclosingClass}`)
        : moduleId;
      store.putRelation({
        kind: "DECLARES",
        from: declaredFrom,
        to: symId,
        resolution: Resolution.EXACT,
        location: { file: f.file, line: fn.line, column: fn.col },
        attributes: {},
      });
      addCandidate(fn.name, symId);
      addCandidate(fn.qualifiedName, symId);

      store.addEvidence({
        fact: `${fn.isMethod ? "method" : "function"} ${fn.qualifiedName} declared in ${f.file}`,
        source: "python3 ast.parse",
        sourceType: "python-ast",
        location: { file: f.file, line: fn.line, column: fn.col },
        revision: store.revision,
        derivation: "python-ast-def-visited",
        status: EvidenceStatus.RESOLVED,
        producedBy: "ResolvePythonSymbols",
        supports: [symId],
      });
    }
  }

  // ---- imports (best-effort, in-repo-only resolution)
  for (const f of extracted.files) {
    const fromModuleId = entityId("Module", `py:${f.module}`);
    for (const imp of f.imports) {
      const targetDotted = resolveImportTarget(f.module, imp);
      const targetId = targetDotted ? moduleByDotted.get(targetDotted) ?? null : null;
      store.putRelation({
        kind: "IMPORTS",
        from: fromModuleId,
        to: targetId,
        resolution: targetId ? Resolution.PARTIAL : Resolution.UNRESOLVED,
        location: { file: f.file, line: imp.line, column: imp.col },
        attributes: {
          statement: imp.kind === "import" ? `import ${imp.module}` : `from ${".".repeat(imp.level)}${imp.module ?? ""} import ${imp.name}`,
          external: targetId ? false : true,
        },
      });
      if (!targetId) {
        store.addUnknown({
          kind: "unresolved-call",
          location: { file: f.file, line: imp.line, column: imp.col },
          detail: `import target "${targetDotted ?? imp.module ?? imp.name}" not found among this repository's Python modules (assumed stdlib/third-party or unresolved relative import)`,
        });
      }
    }
  }

  return byQualifiedName;
}

function resolveImportTarget(currentModule: string, imp: RawImport): string | null {
  if (imp.level === 0) {
    // absolute import: "import a.b.c" or "from a.b import c" (module resolution
    // only, not the imported name — a.b.c may be a name inside module a.b)
    return imp.module ?? null;
  }
  // relative import: level counts leading dots. Level 1 = current package.
  const parts = currentModule.split(".");
  // if this file *is* a package's __init__, its own dotted name already
  // denotes the package; extract.py already folds "pkg.__init__" -> "pkg",
  // so a plain module "pkg" here is ambiguous with a same-named leaf module.
  // Conservative choice: treat the current module's own directory as the
  // package for level 1, which is correct for the common (non-__init__) case.
  let base = parts.slice(0, -1);
  if (imp.level > 1) base = base.slice(0, Math.max(0, base.length - (imp.level - 1)));
  if (imp.module) return [...base, imp.module].join(".");
  if (imp.name) return [...base, imp.name].join(".");
  return base.join(".") || null;
}

/**
 * ResolvePythonCalls: CALLS edges from syntactic call sites.
 *
 * Deliberately HEURISTIC, not SOUND_UNDER_ASSUMPTIONS like the TS call
 * resolver: there is no type checker backing this, only name matching
 * against declarations found in-repo. A single name match is reported
 * PARTIAL (not EXACT — EXACT is reserved for resolution this engine can
 * actually stand behind), multiple matches are AMBIGUOUS, and anything
 * unmatched is UNRESOLVED (builtin, stdlib, third-party, or genuinely
 * dynamic).
 */
export function acquirePythonCalls(
  extracted: ExtractorOutput,
  store: KnowledgeStore,
  counters: Counters,
  byQualifiedName: Map<string, string[]>,
): void {
  for (const f of extracted.files) {
    for (const call of f.calls) {
      if (!call.callee) continue;
      counters.symbolsProcessed += 1;

      const callerId = call.caller ? entityId(pickFuncOrMethodKind(f, call.caller), `${f.file}::${call.caller}`) : null;

      if (PY_BUILTINS.has(call.callee) && !call.isAttribute) {
        const builtinRel = store.putRelation({
          kind: "CALLS",
          from: callerId ?? entityId("Module", `py:${f.module}`),
          to: null,
          resolution: Resolution.UNRESOLVED,
          location: { file: f.file, line: call.line, column: call.col },
          attributes: { calleeText: call.callee, builtin: true },
        });
        store.addEvidence({
          fact: `${call.caller ?? f.module} calls builtin ${call.callee}`,
          source: "python3 ast.parse",
          sourceType: "python-ast",
          location: { file: f.file, line: call.line, column: call.col },
          revision: store.revision,
          derivation: "python-ast-call-site-builtin",
          status: EvidenceStatus.UNRESOLVED,
          producedBy: "ResolvePythonCalls",
          supports: [builtinRel.id],
        });
        continue;
      }

      const candidates = byQualifiedName.get(call.callee) ?? [];
      let targetId: string | null = null;
      let resolution: Resolution;
      if (candidates.length === 0) {
        resolution = Resolution.UNRESOLVED;
      } else if (candidates.length === 1) {
        targetId = candidates[0] ?? null;
        resolution = Resolution.PARTIAL;
      } else {
        resolution = Resolution.AMBIGUOUS;
        store.addUnknown({
          kind: "ambiguous-call",
          location: { file: f.file, line: call.line, column: call.col },
          detail: `call to "${call.callee}" name-matches ${candidates.length} declarations in this repository; no type information is available to disambiguate`,
        });
      }

      const callRel = store.putRelation({
        kind: "CALLS",
        from: callerId ?? entityId("Module", `py:${f.module}`),
        to: targetId,
        resolution,
        location: { file: f.file, line: call.line, column: call.col },
        attributes: {
          calleeText: call.callee,
          isAttribute: call.isAttribute,
          candidateCount: candidates.length,
          // comma-joined entity ids, same shape as the TS CALLS relation's
          // `candidates` attribute (see findCallersTask) — needed so a
          // consumer can tell *which* declarations an AMBIGUOUS call could
          // reach, not just how many.
          candidates: candidates.join(",") || null,
        },
      });

      const callerName = call.caller ?? f.module;
      store.addEvidence({
        fact:
          targetId !== null
            ? `${callerName} calls ${call.callee} (name-matched target ${targetId})`
            : `${callerName} contains a call to "${call.callee}" whose target is ${resolution}`,
        source: "python3 ast.parse",
        sourceType: "python-ast",
        location: { file: f.file, line: call.line, column: call.col },
        revision: store.revision,
        derivation: "python-ast-call-site",
        // Python resolution is name-based only (no type checker), so it is
        // never entitled to EvidenceStatus.RESOLVED the way a type-checked
        // TS call is — PARTIAL is the ceiling even for a single-candidate match.
        status: resolution === Resolution.UNRESOLVED ? EvidenceStatus.UNRESOLVED : EvidenceStatus.PARTIAL,
        producedBy: "ResolvePythonCalls",
        supports: [callRel.id, ...(callerId ? [callerId] : []), ...(targetId ? [targetId] : [])],
      });

      if (resolution !== Resolution.AMBIGUOUS && candidates.length === 0 && call.isAttribute === false) {
        store.addUnknown({
          kind: "unresolved-call",
          location: { file: f.file, line: call.line, column: call.col },
          detail: `call to "${call.callee}" does not name-match any declaration in this repository (assumed builtin, stdlib, third-party, or dynamic)`,
        });
      }
    }
  }
}

function pickFuncOrMethodKind(f: RawFile, qualifiedName: string): EntityKind {
  const fn = f.functions.find((x) => x.qualifiedName === qualifiedName);
  return fn?.isMethod ? "Method" : "Function";
}

/**
 * Convenience: run all three Python acquisition passes against a repo root
 * and return the raw extractor output (useful for callers/tests that want
 * both the populated store and the intermediate facts).
 *
 * NOT wired into `Engine`, the planner, `ANALYSES`/`ANALYSIS_LEVEL`, or the
 * CLI. Those all assume a single ts.Program-shaped `ProgramHandle` and a
 * crystallization level that is meaningful across an entire repository;
 * adding Python analyses to `ANALYSIS_LEVEL` as written would make every
 * TypeScript-only repository (including every existing test fixture) stall
 * at crystallization level 0 forever, since `crystallizationLevel()`
 * requires every analysis at a level to have completed and a repo with no
 * .py files can never satisfy a Python analysis's precondition. Making the
 * level system language-aware (skip analyses whose precondition never
 * holds for a given repo, rather than treating "never ran" and "can't ever
 * run here" the same way) is a real design change to
 * `crystallization/levels.ts` and the planner, not a wiring afterthought —
 * left undone this pass rather than shipped as a silent regression.
 */
export function indexPythonRepository(
  root: string,
  store: KnowledgeStore,
  counters: Counters,
  files?: string[],
): ExtractorOutput {
  const handle = loadPythonProgram(root, files);
  const extracted = acquirePythonFilesAndModules(handle, store, counters);
  const byQualifiedName = acquirePythonSymbols(extracted, store, counters);
  acquirePythonCalls(extracted, store, counters, byQualifiedName);
  return extracted;
}
