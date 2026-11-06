import fs from "node:fs";
import path from "node:path";
import { EvidenceStatus, Resolution, entityId } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { Counters } from "../cost/measure.js";

/**
 * Documentation knowledge.
 *
 * Reads the repository's own markdown (README, AGENTS.md, CONTRIBUTING.md,
 * ADR/RFC directories, docs/) and links documents to entities it can actually
 * establish a relationship with:
 *   - DOCUMENTS: the document contains a path that resolves to a known File.
 *   - MENTIONS: the document contains a code-span identifier that is exactly
 *     the name of a known symbol.
 * Nothing is inferred from prose semantics. A referenced path that does not
 * exist is recorded as measurable documentation drift.
 */

const DOC_NAMES = new Set([
  "readme.md",
  "agents.md",
  "contributing.md",
  "architecture.md",
  "changelog.md",
  "security.md",
]);

const DOC_DIRS = ["docs", "doc", "adr", "rfc", "architecture", ".github"];

export interface DocFile {
  file: string;
  kind: "readme" | "agents" | "contributing" | "adr" | "rfc" | "doc";
  text: string;
}

function classify(relPath: string): DocFile["kind"] {
  const base = path.basename(relPath).toLowerCase();
  const dir = relPath.toLowerCase();
  if (base === "readme.md") return "readme";
  if (base === "agents.md") return "agents";
  if (base === "contributing.md") return "contributing";
  if (/adr/.test(dir) || /^\d{3,4}-/.test(base)) return "adr";
  if (/rfc/.test(dir)) return "rfc";
  return "doc";
}

/** Enumerates markdown documentation without walking node_modules or .git. */
export function listDocumentationFiles(root: string, maxFiles = 400): DocFile[] {
  const out: DocFile[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "build", "coverage"].includes(entry.name)) continue;
        if (depth === 0 && !DOC_DIRS.includes(entry.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (depth === 0 && !DOC_NAMES.has(entry.name.toLowerCase())) continue;
      try {
        out.push({ file: rel, kind: classify(rel), text: fs.readFileSync(abs, "utf8") });
      } catch {
        /* unreadable file: skipped, not invented */
      }
      if (out.length >= maxFiles) return;
    }
  };
  walk(root, 0);
  return out;
}

export interface DocumentationResult {
  available: boolean;
  documents: number;
  documentsLinked: number;
  symbolMentions: number;
  driftReferences: number;
}

const PATH_RE = /(?:`|\(|\s)((?:\.\/|src\/|tests?\/|scripts\/|packages\/)[\w./-]+\.\w{1,5})/g;
const CODE_SPAN_RE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)(?:\(\))?`/g;

export function acquireDocumentation(
  root: string,
  store: KnowledgeStore,
  counters: Counters,
): DocumentationResult {
  const docs = listDocumentationFiles(root);
  if (docs.length === 0) {
    store.addUnknown({
      kind: "no-documentation",
      location: null,
      detail: "no markdown documentation found in this repository",
    });
    return { available: false, documents: 0, documentsLinked: 0, symbolMentions: 0, driftReferences: 0 };
  }

  const symbolIndex = new Map<string, string[]>();
  for (const e of store.allEntities()) {
    if (!["Function", "Method", "Class", "Interface", "Type", "Symbol"].includes(e.kind)) continue;
    const container = e.attributes.container ? `${String(e.attributes.container)}.${e.name}` : null;
    for (const key of container ? [e.name, container] : [e.name]) {
      const list = symbolIndex.get(key) ?? [];
      list.push(e.id);
      symbolIndex.set(key, list);
    }
  }

  let documentsLinked = 0;
  let symbolMentions = 0;
  let driftReferences = 0;

  for (const doc of docs) {
    counters.filesProcessed += 1;
    const location = { file: doc.file, line: 1, column: 1 };
    const docId = entityId("Documentation", doc.file);
    store.putEntity({
      id: docId,
      kind: "Documentation",
      name: doc.file,
      location,
      attributes: { docKind: doc.kind, bytes: doc.text.length, lines: doc.text.split("\n").length },
    });
    store.addEvidence({
      fact: `${doc.file} is repository documentation of kind ${doc.kind}`,
      source: "filesystem markdown scan",
      sourceType: "documentation",
      location,
      revision: store.revision,
      derivation: "documentation-file",
      status: EvidenceStatus.RESOLVED,
      producedBy: "AnalyzeDocumentation",
      supports: [docId],
    });

    let linked = false;
    const lines = doc.text.split(/\r?\n/);
    lines.forEach((lineText, idx) => {
      const lineNo = idx + 1;
      PATH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_RE.exec(lineText)) !== null) {
        const raw = m[1]!;
        const normalized = raw.replace(/^\.\//, "");
        const targetId = entityId("File", normalized);
        const docLoc = { file: doc.file, line: lineNo, column: (m.index ?? 0) + 1 };
        const exists = store.hasEntity(targetId) || fs.existsSync(path.join(root, normalized));
        if (!exists) {
          driftReferences += 1;
          store.addUnknown({
            kind: "documentation-drift",
            location: docLoc,
            detail: `${doc.file}:${lineNo} references ${normalized}, which does not exist at revision ${store.revision}`,
          });
          store.addEvidence({
            fact: `${doc.file}:${lineNo} references missing path ${normalized}`,
            source: doc.file,
            sourceType: "documentation",
            location: docLoc,
            revision: store.revision,
            derivation: "path-reference-check",
            status: EvidenceStatus.CONFLICTING,
            producedBy: "AnalyzeDocumentation",
            supports: [docId],
          });
          continue;
        }
        if (!store.hasEntity(targetId)) continue;
        linked = true;
        const relation = store.putRelation({
          kind: "DOCUMENTS",
          from: docId,
          to: targetId,
          resolution: Resolution.EXACT,
          location: docLoc,
          attributes: { reference: normalized },
        });
        store.addEvidence({
          fact: `${doc.file}:${lineNo} documents ${normalized}`,
          source: doc.file,
          sourceType: "documentation",
          location: docLoc,
          revision: store.revision,
          derivation: "resolved-path-reference",
          status: EvidenceStatus.RESOLVED,
          producedBy: "AnalyzeDocumentation",
          supports: [relation.id, targetId],
        });
      }

      CODE_SPAN_RE.lastIndex = 0;
      while ((m = CODE_SPAN_RE.exec(lineText)) !== null) {
        const token = m[1]!;
        const targets = symbolIndex.get(token);
        if (!targets || targets.length === 0) continue;
        const docLoc = { file: doc.file, line: lineNo, column: (m.index ?? 0) + 1 };
        // More than one declaration with this name: the mention is ambiguous
        // and is recorded as such rather than being attached to a guess.
        const resolution = targets.length === 1 ? Resolution.EXACT : Resolution.AMBIGUOUS;
        for (const targetId of targets) {
          const relation = store.putRelation({
            kind: "MENTIONS",
            from: docId,
            to: targetId,
            resolution,
            location: docLoc,
            attributes: { token, candidates: targets.length },
          });
          store.addEvidence({
            fact: `${doc.file}:${lineNo} mentions \`${token}\``,
            source: doc.file,
            sourceType: "documentation",
            location: docLoc,
            revision: store.revision,
            derivation: resolution === Resolution.EXACT ? "unique-name-code-span" : "ambiguous-name-code-span",
            status: resolution === Resolution.EXACT ? EvidenceStatus.RESOLVED : EvidenceStatus.PARTIAL,
            producedBy: "AnalyzeDocumentation",
            supports: [relation.id, targetId],
          });
        }
        symbolMentions += 1;
        linked = true;
      }
    });
    if (linked) documentsLinked += 1;
    counters.symbolsProcessed += 1;
  }

  return { available: true, documents: docs.length, documentsLinked, symbolMentions, driftReferences };
}
