type Fn = () => number;
const registered: Fn[] = [];

export function register(handler: Fn): void {
  registered.push(handler);
}

export function fireAll(): number {
  return registered.reduce((a, f) => a + f(), 0);
}
