import { foo } from "./fileC.js";
export function usesC(): boolean {
  return foo();
}
