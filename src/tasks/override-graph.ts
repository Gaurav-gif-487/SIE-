import { Entity } from "../canonical/model.js";
import { KnowledgeStore } from "../knowledge/store.js";

/**
 * Override graph.
 *
 * A call site is resolved by the type checker to exactly one *declaration*.
 * At runtime, the executed body may be a different declaration whenever the
 * receiver is typed against a supertype (interface / base class) or whenever
 * the resolved declaration is itself overridden.
 *
 * This module derives, for a target method declaration, the two declaration
 * sets that make virtual dispatch explicit:
 *
 *   supertypeDecls - declarations in ancestors of the target's container that
 *                    have the same member name. A call resolved to one of
 *                    these MAY execute the target.
 *   subtypeDecls   - declarations in descendants of the target's container.
 *                    A call resolved to the target MAY execute one of these.
 *
 * Both are derived from EXTENDS / IMPLEMENTS relations produced by
 * AnalyzeInheritance (ts heritage clauses), never from name similarity of the
 * containers, and never from fixture-specific knowledge.
 */
export interface OverrideExpansion {
  /** container names walked upward, for provenance */
  ancestors: string[];
  /** container names walked downward, for provenance */
  descendants: string[];
  supertypeDecls: Set<string>;
  subtypeDecls: Set<string>;
}

function typeEntitiesByName(store: KnowledgeStore, name: string): Entity[] {
  return store
    .allEntities()
    .filter((e) => e.name === name && (e.kind === "Class" || e.kind === "Interface"));
}

function walk(
  store: KnowledgeStore,
  startNames: string[],
  direction: "up" | "down",
): string[] {
  const seen = new Set<string>(startNames);
  const out: string[] = [];
  const queue = [...startNames];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const typeEntity of typeEntitiesByName(store, current)) {
      const rels =
        direction === "up"
          ? [
              ...store.relationsFrom(typeEntity.id, "EXTENDS"),
              ...store.relationsFrom(typeEntity.id, "IMPLEMENTS"),
            ]
          : [
              ...store.relationsTo(typeEntity.id, "EXTENDS"),
              ...store.relationsTo(typeEntity.id, "IMPLEMENTS"),
            ];
      for (const rel of rels) {
        const otherId = direction === "up" ? rel.to : rel.from;
        if (!otherId) continue;
        const other = store.getEntity(otherId);
        if (!other || seen.has(other.name)) continue;
        seen.add(other.name);
        out.push(other.name);
        queue.push(other.name);
      }
    }
  }
  return out;
}

function membersNamed(store: KnowledgeStore, containers: string[], member: string): Set<string> {
  const names = new Set(containers);
  const ids = new Set<string>();
  for (const e of store.allEntities()) {
    if (e.name !== member) continue;
    if (!["Method", "Function", "Symbol"].includes(e.kind)) continue;
    const container = e.attributes.container;
    if (typeof container === "string" && names.has(container)) ids.add(e.id);
  }
  return ids;
}

/**
 * Expand a set of target declarations along the inheritance graph.
 * `targets` are the declarations matching the user's query.
 */
export function expandOverrides(
  store: KnowledgeStore,
  targets: { id: string; name: string; container: string | null }[],
): OverrideExpansion {
  const ancestors = new Set<string>();
  const descendants = new Set<string>();
  const supertypeDecls = new Set<string>();
  const subtypeDecls = new Set<string>();

  for (const target of targets) {
    if (!target.container) continue;
    const up = walk(store, [target.container], "up");
    const down = walk(store, [target.container], "down");
    up.forEach((n) => ancestors.add(n));
    down.forEach((n) => descendants.add(n));
    for (const id of membersNamed(store, up, target.name)) {
      if (id !== target.id) supertypeDecls.add(id);
    }
    // The downward direction is NOT symmetric with the upward one. If a
    // descendant declares its own body for the member, that body *replaces*
    // the target at runtime, so a call resolved to the descendant can never
    // execute the queried declaration. Only bodyless descendant declarations
    // (interface members, abstract methods) still dispatch into it.
    for (const id of membersNamed(store, down, target.name)) {
      if (id === target.id) continue;
      const decl = store.getEntity(id);
      const bodyless =
        Boolean(decl?.attributes.abstract) || Boolean(decl?.attributes.declarationOnly);
      if (bodyless) subtypeDecls.add(id);
    }
  }

  return {
    ancestors: [...ancestors],
    descendants: [...descendants],
    supertypeDecls,
    subtypeDecls,
  };
}

/**
 * Concrete implementations of a declaration, i.e. bodies that a call resolved
 * to `decl` may actually execute. Used by FindCallees and ChangeImpact, which
 * need the opposite direction from FindCallers: given the *resolved* callee,
 * which bodies can run?
 */
export function implementationsOf(
  store: KnowledgeStore,
  decl: { id: string; name: string; container: string | null },
): { ids: string[]; descendants: string[] } {
  if (!decl.container) return { ids: [], descendants: [] };
  const down = walk(store, [decl.container], "down");
  const ids: string[] = [];
  for (const id of membersNamed(store, down, decl.name)) {
    if (id === decl.id) continue;
    const entity = store.getEntity(id);
    const bodyless = Boolean(entity?.attributes.abstract) || Boolean(entity?.attributes.declarationOnly);
    if (!bodyless) ids.push(id);
  }
  return { ids, descendants: down };
}
