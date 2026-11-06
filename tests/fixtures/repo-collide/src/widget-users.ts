import { Widget } from "./widgets.js";
import { Widget as AltWidget } from "./widgets-alt.js";

export function useFirst(): string {
  return new Widget("x").render();
}
export function useSecond(): string {
  return new AltWidget(2).render();
}
