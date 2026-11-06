import { fooFromA } from "./barrel.js";
export function usesBarrelA(): number {
  return fooFromA();
}
