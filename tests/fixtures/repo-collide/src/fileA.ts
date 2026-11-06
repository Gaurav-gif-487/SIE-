// Collision family 1: three unrelated functions all named `foo`.
export function foo(): number {
  return helperA();
}
export function helperA(): number {
  return 1;
}
