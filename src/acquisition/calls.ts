import ts from "typescript";
import { EvidenceStatus, Resolution, SourceLocation } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { Counters } from "../cost/measure.js";
import { ProgramHandle, rel } from "./program.js";
import {
  declarationId,
  declarationKind,
  declarationName,
  enclosingDeclaration,
  locOf,
  namedDeclarationOf,
} from "./ast-utils.js";

export interface CallSite {
  /** relation id in the knowledge store */
  relationId: string;
  location: SourceLocation;
  calleeText: string;
  callerId: string | null;
  callerName: string;
  /** best resolved target entity id, null when unresolved */
  targetId: string | null;
  /** every declaration the engine considers possible (>1 => ambiguous) */
  candidateIds: string[];
  resolution: Resolution;
  receiverType: string | null;
  derivation: string;
  risk: null | "dynamic-dispatch" | "reflection" | "any-receiver" | "external-declaration";
}

function declIdOf(decl: ts.Node, root: string): string | null {
  // Redirect a bare arrow/function-expression node to the named
  // VariableDeclaration/PropertyDeclaration that gives it its identity, so
  // the id matches what symbols.ts registered for `const foo = () => {}`
  // and `class X { m = () => {} }` (see namedDeclarationOf).
  const target = namedDeclarationOf(decl);
  const kind = declarationKind(target);
  const name = declarationName(target);
  if (!kind || !name) return null;
  return declarationId(kind, target, name, root);
}

function callableDeclarations(symbol: ts.Symbol): ts.Node[] {
  return (symbol.declarations ?? []).filter(
    (d) =>
      ts.isFunctionDeclaration(d) ||
      ts.isMethodDeclaration(d) ||
      ts.isMethodSignature(d) ||
      ts.isConstructorDeclaration(d) ||
      ts.isArrowFunction(d) ||
      ts.isFunctionExpression(d) ||
      ts.isVariableDeclaration(d) ||
      ts.isPropertyDeclaration(d) ||
      ts.isClassDeclaration(d) ||
      ts.isGetAccessorDeclaration(d) ||
      ts.isSetAccessorDeclaration(d),
  );
}

function isInRepo(decl: ts.Node, root: string): boolean {
  const file = decl.getSourceFile().fileName;
  return !file.includes("/node_modules/") && file.startsWith(root);
}

/**
 * ResolveCalls: type-aware call resolution.
 *
 * `a.run()` and `b.run()` are resolved through the checker's symbol for the
 * property access, i.e. through the receiver's *type*, never through the name
 * `run`. Where the checker cannot decide, the site is recorded as AMBIGUOUS or
 * UNRESOLVED and contributes to residual risk.
 */
export function acquireCalls(
  handle: ProgramHandle,
  store: KnowledgeStore,
  counters: Counters,
): CallSite[] {
  const { checker, root } = handle;
  const sites: CallSite[] = [];

  for (const sf of handle.sourceFiles) {
    const file = rel(root, sf.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        sites.push(resolveOne(node, sf, file, handle, store));
        counters.symbolsProcessed += 1;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    counters.filesProcessed += 1;
  }

  void checker;
  return sites;
}

function resolveOne(
  node: ts.CallExpression | ts.NewExpression,
  sf: ts.SourceFile,
  file: string,
  handle: ProgramHandle,
  store: KnowledgeStore,
): CallSite {
  const { checker, root } = handle;
  const location = locOf(sf, node, root);
  const callee = node.expression;
  const calleeText = callee.getText(sf);
  // Unwrap `x!`/`(x)` so that `map[key]!()` is still seen as element access.
  let calleeCore: ts.Expression = callee;
  while (ts.isNonNullExpression(calleeCore) || ts.isParenthesizedExpression(calleeCore)) {
    calleeCore = calleeCore.expression;
  }

  // Attribution. The nearest enclosing function-like node may be an anonymous
  // arrow/function expression (a callback), which has no declaration entity.
  // Walking further up attributes the call to the named declaration that
  // *contains* the closure, so calls inside callbacks are not silently
  // reassigned to the file. `viaClosure` keeps that indirection visible.
  let encl = enclosingDeclaration(node);
  let viaClosure = false;
  while (encl && declIdOf(encl, root) === null) {
    viaClosure = true;
    encl = enclosingDeclaration(encl);
  }
  const callerId = encl ? declIdOf(encl, root) : null;
  const callerName = encl ? (declarationName(namedDeclarationOf(encl)) ?? "<anonymous>") : "<module-top-level>";

  let receiverType: string | null = null;
  let risk: CallSite["risk"] = null;
  let derivation = "direct-call-expression";
  let resolution = Resolution.UNRESOLVED;
  let candidateDecls: ts.Node[] = [];

  // Dynamic dispatch through computed member access: obj["run"]() / obj[k]()
  if (ts.isElementAccessExpression(calleeCore)) {
    risk = "dynamic-dispatch";
    derivation = "element-access-call";
    store.addUnknown({
      kind: "dynamic-dispatch",
      location,
      detail: `call target computed at runtime: ${calleeText}`,
    });
  }

  // Reflection-style invocation
  if (/^(Reflect\.(apply|get|construct)|eval|Function)\b/.test(calleeText) || /\.(apply|call|bind)$/.test(calleeText)) {
    risk = "reflection";
    derivation = "reflective-invocation";
    store.addUnknown({
      kind: "reflection",
      location,
      detail: `reflective invocation: ${calleeText}`,
    });
  }

  if (ts.isPropertyAccessExpression(callee)) {
    const recvType = checker.getTypeAtLocation(callee.expression);
    receiverType = checker.typeToString(recvType);
    derivation = "property-access-call:receiver-type";
    if (receiverType === "any" || receiverType === "unknown") {
      risk = risk ?? "any-receiver";
      store.addUnknown({
        kind: "dynamic-dispatch",
        location,
        detail: `receiver of ${calleeText} has type ${receiverType}; target cannot be established from types`,
      });
    }
  }

  // Primary path: checker symbol for the callee expression (alias-aware).
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
    derivation += "+alias-resolved";
  }
  if (symbol) candidateDecls = callableDeclarations(symbol);

  // Secondary path: resolved signature (covers overloads, call-expression callees).
  if (candidateDecls.length === 0) {
    const signature = checker.getResolvedSignature(node);
    if (signature?.declaration) {
      candidateDecls = [signature.declaration];
      derivation += "+resolved-signature";
    }
  }

  // Union receivers: each constituent may declare its own member.
  if (ts.isPropertyAccessExpression(callee)) {
    const recvType = checker.getTypeAtLocation(callee.expression);
    if (recvType.isUnion()) {
      const memberDecls: ts.Node[] = [];
      for (const constituent of recvType.types) {
        const prop = constituent.getProperty(callee.name.text);
        for (const d of prop?.declarations ?? []) memberDecls.push(d);
      }
      if (memberDecls.length > 0) {
        candidateDecls = [...new Set([...candidateDecls, ...memberDecls])];
        derivation += "+union-receiver";
      }
    }
  }

  const inRepo = candidateDecls.filter((d) => isInRepo(d, root));
  const external = candidateDecls.length > 0 && inRepo.length === 0;
  const candidateIds = [...new Set(inRepo.map((d) => declIdOf(d, root)).filter((v): v is string => Boolean(v)))];

  if (external) {
    risk = risk ?? "external-declaration";
    resolution = Resolution.PARTIAL;
  } else if (candidateIds.length === 1) {
    // A single in-repo declaration. If it is only an interface/abstract
    // signature, the concrete runtime target is not established -> PARTIAL.
    const decl = inRepo[0]!;
    const declaresOnly =
      ts.isMethodSignature(decl) ||
      (ts.canHaveModifiers(decl) &&
        Boolean(ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)));
    resolution = declaresOnly ? Resolution.PARTIAL : Resolution.EXACT;
    if (declaresOnly) derivation += "+declaration-site-only";
  } else if (candidateIds.length > 1) {
    resolution = Resolution.AMBIGUOUS;
    store.addUnknown({
      kind: "ambiguous-call",
      location,
      detail: `${calleeText} has ${candidateIds.length} possible in-repository targets`,
    });
  } else {
    resolution = Resolution.UNRESOLVED;
    store.addUnknown({
      kind: "unresolved-call",
      location,
      detail: `no declaration could be established for ${calleeText}`,
    });
  }

  const targetId = resolution === Resolution.EXACT || resolution === Resolution.PARTIAL ? candidateIds[0] ?? null : null;

  const relation = store.putRelation({
    kind: "CALLS",
    from: callerId ?? `File:${file}`,
    to: targetId,
    resolution,
    location,
    attributes: {
      calleeText,
      receiverType,
      candidates: candidateIds.join(","),
      candidateCount: candidateIds.length,
      risk,
      external,
      derivation,
      callerName,
      viaClosure,
    },
  });

  store.addEvidence({
    fact:
      targetId !== null
        ? `${callerName} calls ${calleeText} (target ${targetId})`
        : `${callerName} contains a call to ${calleeText} whose target is ${resolution}`,
    source:
      derivation.includes("resolved-signature")
        ? "ts.TypeChecker#getResolvedSignature"
        : "ts.TypeChecker#getSymbolAtLocation",
    sourceType: "typescript-compiler",
    location,
    revision: store.revision,
    derivation,
    status:
      resolution === Resolution.EXACT
        ? EvidenceStatus.RESOLVED
        : resolution === Resolution.PARTIAL
          ? EvidenceStatus.PARTIAL
          : resolution === Resolution.AMBIGUOUS
            ? EvidenceStatus.PARTIAL
            : EvidenceStatus.UNRESOLVED,
    producedBy: "ResolveCalls",
    supports: [relation.id, ...(callerId ? [callerId] : []), ...(targetId ? [targetId] : [])],
  });

  return {
    relationId: relation.id,
    location,
    calleeText,
    callerId,
    callerName,
    targetId,
    candidateIds,
    resolution,
    receiverType,
    derivation,
    risk,
  };
}

/**
 * BuildReferences: non-call identifier references, resolved via the checker.
 * Needed to distinguish "referenced" from "called" for a target symbol.
 */
export function acquireReferences(handle: ProgramHandle, store: KnowledgeStore, counters: Counters): void {
  const { checker, root } = handle;
  for (const sf of handle.sourceFiles) {
    const file = rel(root, sf.fileName);
    const visit = (node: ts.Node): void => {
      const isDeclName =
        ts.isIdentifier(node) && (node.parent as ts.NamedDeclaration | undefined)?.name === node;
      if (ts.isIdentifier(node) && !isDeclName) {
        const parent = node.parent;
        const isCallee =
          (ts.isCallExpression(parent) && parent.expression === node) ||
          (ts.isPropertyAccessExpression(parent) &&
            parent.name === node &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent);
        if (!isCallee) {
          let symbol = checker.getSymbolAtLocation(node);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          const decl = symbol?.declarations?.find((d) => isInRepo(d, root));
          const targetId = decl ? declIdOf(decl, root) : null;
          if (targetId) {
            const encl = enclosingDeclaration(node);
            const location = locOf(sf, node, root);
            const relation = store.putRelation({
              kind: "REFERENCES",
              from: encl ? (declIdOf(encl, root) ?? `File:${file}`) : `File:${file}`,
              to: targetId,
              resolution: Resolution.EXACT,
              location,
              attributes: { text: node.text },
            });
            store.addEvidence({
              fact: `${node.text} is referenced at ${location.file}:${location.line}`,
              source: "ts.TypeChecker#getSymbolAtLocation",
              sourceType: "typescript-compiler",
              location,
              revision: store.revision,
              derivation: "identifier-reference",
              status: EvidenceStatus.RESOLVED,
              producedBy: "BuildReferences",
              supports: [relation.id, targetId],
            });
            counters.symbolsProcessed += 1;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    counters.filesProcessed += 1;
  }
}
