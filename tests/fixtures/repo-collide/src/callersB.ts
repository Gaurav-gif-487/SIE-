import { foo } from "./fileB.js";
export function usesB(): string {
  return foo();
}
