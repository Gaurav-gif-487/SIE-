// Collision family 2: same-named constructors + identical method names.
export class Widget {
  constructor(public readonly kind: string) {}
  render(): string {
    return `wa:${this.kind}`;
  }
}
