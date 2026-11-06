import assert from "node:assert";
import { test } from "node:test";
import { processTask } from "../src/truncator.js";

test("processTask runs correctly", () => {
  assert.strictEqual(processTask(), true);
});
