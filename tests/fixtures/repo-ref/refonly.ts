import { target } from "./target.js";

/**
 * Reference-only: `target` is passed around as a value and stored, but this
 * module never invokes it. Under call semantics this file is NOT impacted by
 * a change to target's body; under reference semantics it is.
 */
export const registry: Array<() => number> = [target];

export function describeTarget(): string {
  return typeof target;
}
