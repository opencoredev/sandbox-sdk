import { test } from "node:test";
import assert from "node:assert/strict";

test("deterministic agent task", () =>
  assert.equal(
    [1, 2, 3].reduce((a, b) => a + b, 0),
    6,
  ));
