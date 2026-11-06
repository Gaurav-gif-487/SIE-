import { Handler } from "./types.js";
import { FastJson, XmlHandler, Unrelated } from "./barrel.js";

/** generic receiver constrained to an interface */
export function invokeGeneric<T extends Handler>(h: T): string {
  return h.handle("g");
}

/** union receiver: both constituents declare the member */
export function invokeUnion(h: FastJson | XmlHandler): string {
  return h.handle("u");
}

/** intersection receiver */
export function invokeIntersection(h: Handler & { id: string }): string {
  return h.handle(h.id);
}

/** direct call through an aliased re-export */
export function invokeAlias(): string {
  const h = new FastJson();
  return h.handle("a");
}

/** same-name member on an unrelated class: must NOT be attributed */
export function invokeUnrelated(): string {
  const u = new Unrelated();
  return u.handle("n");
}

/** inherited concrete method reached through a subclass receiver */
export function invokeInherited(): string {
  const h = new FastJson();
  return h.log("i");
}
