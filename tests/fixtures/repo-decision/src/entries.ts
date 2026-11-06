import { targetEasy, targetMedium as aliasTarget, targetCallback, targetHof, targetReferenced } from "./leaves.js";
import { DerivedService } from "./barrel.js";
import { Service } from "./ctor.js";
import { AlphaHandler, BetaHandler, Handler } from "./dispatch.js";
import { register } from "./registry.js";

/** EASY: direct call A -> B. */
export function entryEasy(): number {
  return targetEasy();
}

/** MEDIUM: import alias A -> alias -> B. */
export function entryAlias(): number {
  return aliasTarget();
}

/** HARD: barrel + alias + inheritance. */
export function entryHard(): number {
  const svc: DerivedService = new DerivedService();
  return svc.perform();
}

/** CALLBACK: the real callee is passed indirectly and invoked by the registry. */
export function entryCallback(): number {
  register(targetCallback);
  return 0;
}

/** HIGHER-ORDER: the relevant call lives inside the transform passed to map. */
export function entryHof(items: number[]): number[] {
  const transform = (n: number): number => n + targetHof();
  return items.map(transform);
}

/** CONSTRUCTOR: new Service() runs the constructor body. */
export function entryConstructor(): number {
  return new Service().seed;
}

/** DYNAMIC DISPATCH: interface-typed receiver, two implementations. */
export function entryDynamic(flag: boolean): number {
  const h: Handler = flag ? new AlphaHandler() : new BetaHandler();
  return h.handleEvent();
}

/** REFERENCE-ONLY: symbol used as a value, never invoked here. */
export function entryReferenceOnly(): Array<() => number> {
  return [targetReferenced];
}

/** UNRESOLVABLE: reflection-like lookup; not provable statically. */
export function entryUnresolvable(name: string): number {
  const table = globalThis as unknown as Record<string, () => number>;
  return table[name]!();
}
