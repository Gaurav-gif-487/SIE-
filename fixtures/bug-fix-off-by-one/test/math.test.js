import assert from "node:assert";
import { test } from "node:test";
import { calculateAverage } from "../src/math.js";

test("calculateAverage computes correct mean", () => {
  assert.strictEqual(calculateAverage([10, 20, 30]), 20);
});
