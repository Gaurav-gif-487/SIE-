import { foo } from "./fileA.js";
export function usesA(): number {
  return foo();
}
