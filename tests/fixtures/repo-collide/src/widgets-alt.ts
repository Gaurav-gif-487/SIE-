export class Widget {
  constructor(public readonly id: number) {}
  render(): string {
    return `wb:${this.id}`;
  }
}
