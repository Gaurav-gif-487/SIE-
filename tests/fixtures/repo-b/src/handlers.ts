import { BaseHandler, Handler } from "./types.js";

export class JsonHandler extends BaseHandler {
  handle(input: string): string {
    return `{"v":"${input}"}`;
  }
}

export class XmlHandler extends BaseHandler {
  handle(input: string): string {
    return `<v>${input}</v>`;
  }
}

/** Same member name, no inheritance relation to Handler at all. */
export class Unrelated {
  handle(input: string): string {
    return input;
  }
}

export function makeHandler(kind: "json" | "xml"): Handler {
  return kind === "json" ? new JsonHandler() : new XmlHandler();
}
