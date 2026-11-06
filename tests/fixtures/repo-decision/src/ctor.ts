import { targetCtor } from "./leaves.js";

export class Service {
  readonly seed: number;
  constructor() {
    this.seed = targetCtor();
  }
}
