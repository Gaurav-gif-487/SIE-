import { JsonHandler, makeHandler } from "./handlers.js";
import * as ns from "./handlers.js";
import defaultRun from "./default-export.js";

/** the target is passed as a method reference and invoked indirectly */
export function viaMethodReference(): string {
  const h = new JsonHandler();
  const fn = h.handle.bind(h);
  return fn("m");
}

/** function stored in a variable, then called */
export function viaFunctionVariable(): string {
  const fn = makeHandler;
  const h = fn("json");
  return h.handle("v");
}

/** callback parameter typed as the interface method shape */
export function viaCallback(cb: (input: string) => string): string {
  return cb("c");
}

export function passesCallback(): string {
  const h = new JsonHandler();
  return viaCallback((s) => h.handle(s));
}

/** optional chaining on a nullable receiver */
export function viaOptionalChain(h: JsonHandler | null): string | undefined {
  return h?.handle("o");
}

/** computed member access: target is not established statically */
export function viaComputedAccess(h: JsonHandler, key: "handle"): string {
  return h[key]("k");
}

/** namespace import */
export function viaNamespace(): string {
  return ns.makeHandler("xml").handle("ns");
}

/** default export re-invocation */
export function viaDefaultExport(): string {
  return defaultRun("d");
}
