import fs from "node:fs";
import path from "node:path";
import { Entity, EntityKind } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { concatFields, fieldMessage, fieldPackedVarints, fieldString, fieldVarint } from "./protobuf.js";

/**
 * Export currently-known facts as a SCIP index.
 *
 * Root cause this addresses: SIE's symbol model was bespoke, with no
 * interchange format, so nothing else in the ecosystem (Sourcegraph, editors
 * that consume SCIP/LSIF) could reuse what SIE already knows about a
 * repository. Exporting to SCIP is the "conventional facts" layer this
 * engine's evidence/uncertainty/risk reasoning sits on top of — it does not
 * replace that reasoning, it just makes the plain facts (symbol exists at
 * X, symbol is used at Y) interoperable.
 *
 * Scope: this exports declared symbols (Function/Method/Class/Interface/
 * Type/Module) as `SymbolInformation` with a definition `Occurrence`, plus a
 * reference `Occurrence` for every resolved CALLS/REFERENCES relation this
 * engine has evidence for. It is a best-effort mapping, not a certified SCIP
 * indexer: symbol strings are stable within one export but are not
 * guaranteed to match what an official TypeScript SCIP indexer would emit.
 */

const SCIP_KIND: Partial<Record<EntityKind, number>> = {
  Function: 17,
  Method: 26,
  Class: 7,
  Interface: 21,
  Type: 54,
  Module: 29,
};

const SYMBOL_ROLE_DEFINITION = 0x1;

export interface ScipOccurrence {
  line: number; // 0-based
  startCharacter: number;
  endCharacter: number;
  symbol: string;
  isDefinition: boolean;
}

export interface ScipSymbolInformation {
  symbol: string;
  displayName: string;
  kind: number;
}

export interface ScipDocument {
  relativePath: string;
  language: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

export interface ScipIndex {
  projectRoot: string;
  toolName: string;
  toolVersion: string;
  documents: ScipDocument[];
}

/** Build a syntactically-valid (if simplified) SCIP symbol string for an entity. */
function symbolFor(entity: Entity, packageName: string): string {
  const scheme = "scip-typescript-sie";
  const pkg = `. ${sanitize(packageName)} .`;
  const file = entity.location?.file ?? "unknown";
  const namespaceParts = file.replace(/\.[tj]sx?$/, "").split("/").filter(Boolean);
  const namespace = namespaceParts.map((seg) => `${sanitize(seg)}/`).join("");
  const suffix = entity.kind === "Method" ? `${sanitize(entity.name)}().` : `${sanitize(entity.name)}#`;
  return `${scheme} ${pkg} ${namespace}${suffix}`;
}

/** Symbol strings escape spaces by doubling them and must not be empty. */
function sanitize(s: string): string {
  const cleaned = s.replace(/ /g, "  ").trim();
  return cleaned.length > 0 ? cleaned : "_";
}

function language(file: string): string {
  if (file.endsWith(".tsx")) return "TypeScriptReact";
  if (file.endsWith(".jsx")) return "JavaScriptReact";
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) return "TypeScript";
  return "JavaScript";
}

export function exportScip(store: KnowledgeStore, root: string): ScipIndex {
  const packageName = path.basename(root) || "repository";
  const byFile = new Map<string, ScipDocument>();
  const docFor = (file: string): ScipDocument => {
    let doc = byFile.get(file);
    if (!doc) {
      doc = { relativePath: file, language: language(file), occurrences: [], symbols: [] };
      byFile.set(file, doc);
    }
    return doc;
  };

  const symbolIdByEntity = new Map<string, string>();

  for (const kind of Object.keys(SCIP_KIND) as EntityKind[]) {
    for (const entity of store.entitiesOfKind(kind)) {
      if (!entity.location) continue;
      const symbol = symbolFor(entity, packageName);
      symbolIdByEntity.set(entity.id, symbol);
      const doc = docFor(entity.location.file);
      doc.symbols.push({ symbol, displayName: entity.name, kind: SCIP_KIND[kind] ?? 0 });
      doc.occurrences.push({
        line: Math.max(0, entity.location.line - 1),
        startCharacter: Math.max(0, entity.location.column - 1),
        endCharacter: Math.max(0, entity.location.column - 1) + entity.name.length,
        symbol,
        isDefinition: true,
      });
    }
  }

  for (const rel of [...store.relationsOfKind("CALLS"), ...store.relationsOfKind("REFERENCES")]) {
    if (!rel.location || !rel.to) continue;
    const symbol = symbolIdByEntity.get(rel.to);
    if (!symbol) continue; // target isn't a declared symbol we exported (e.g. external library)
    const doc = docFor(rel.location.file);
    const nameLength = rel.to.split(":").pop()?.length ?? 1;
    doc.occurrences.push({
      line: Math.max(0, rel.location.line - 1),
      startCharacter: Math.max(0, rel.location.column - 1),
      endCharacter: Math.max(0, rel.location.column - 1) + Math.max(1, nameLength),
      symbol,
      isDefinition: false,
    });
  }

  return {
    projectRoot: root,
    toolName: "software-intelligence-engine",
    toolVersion: "2.0.0",
    documents: [...byFile.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

// --------------------------------------------------------------- encoding

function encodeOccurrence(occ: ScipOccurrence): Buffer {
  const range =
    occ.startCharacter === occ.endCharacter
      ? [occ.line, occ.startCharacter, occ.endCharacter]
      : [occ.line, occ.startCharacter, occ.line, occ.endCharacter];
  const roles = occ.isDefinition ? SYMBOL_ROLE_DEFINITION : 0;
  return concatFields(
    fieldPackedVarints(1, range),
    fieldString(2, occ.symbol),
    // proto3 omits default-valued (0) fields on the wire; do the same.
    ...(roles !== 0 ? [fieldVarint(3, roles)] : []),
  );
}

function encodeSymbolInformation(sym: ScipSymbolInformation): Buffer {
  return concatFields(fieldString(1, sym.symbol), fieldVarint(5, sym.kind), fieldString(6, sym.displayName));
}

function encodeDocument(doc: ScipDocument): Buffer {
  return concatFields(
    fieldString(1, doc.relativePath),
    ...doc.occurrences.map((o) => fieldMessage(2, encodeOccurrence(o))),
    ...doc.symbols.map((s) => fieldMessage(3, encodeSymbolInformation(s))),
    fieldString(4, doc.language),
    fieldVarint(6, 2 /* UTF16CodeUnitOffsetFromLineStart */),
  );
}

function encodeToolInfo(name: string, version: string): Buffer {
  return concatFields(fieldString(1, name), fieldString(2, version));
}

function encodeMetadata(index: ScipIndex): Buffer {
  return concatFields(
    fieldVarint(1, 0 /* UnspecifiedProtocolVersion */),
    fieldMessage(2, encodeToolInfo(index.toolName, index.toolVersion)),
    fieldString(3, index.projectRoot),
    fieldVarint(4, 1 /* UTF8 */),
  );
}

/** Encode a ScipIndex to the SCIP protobuf wire format. */
export function encodeScipIndex(index: ScipIndex): Buffer {
  return concatFields(
    fieldMessage(1, encodeMetadata(index)),
    ...index.documents.map((d) => fieldMessage(2, encodeDocument(d))),
  );
}

export function writeScipFile(index: ScipIndex, outPath: string): void {
  fs.writeFileSync(outPath, encodeScipIndex(index));
}
