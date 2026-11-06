import { JsonHandler } from "./handlers.js";

export default function run(input: string): string {
  const h = new JsonHandler();
  return h.handle(input);
}
