import { targetDispatchA, targetDispatchB } from "./leaves.js";

export interface Handler {
  handleEvent(): number;
}

export class AlphaHandler implements Handler {
  handleEvent(): number {
    return targetDispatchA();
  }
}

export class BetaHandler implements Handler {
  handleEvent(): number {
    return targetDispatchB();
  }
}
