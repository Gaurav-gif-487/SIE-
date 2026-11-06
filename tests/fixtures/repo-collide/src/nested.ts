// Collision family 4: a nested declaration that shadows the module-level name.
export function outer(): number {
  function foo(): number {
    return 42;
  }
  return foo();
}
