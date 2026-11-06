import { target } from "./target.js";

/**plain call: target() actually executes here. */
export function callsTarget(): number {
  return target() + 1;
}
