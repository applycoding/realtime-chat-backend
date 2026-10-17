import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, windowId } from "../../src/chat/ratelimit.js";

test("windowId changes on the window boundary", () => {
  assert.equal(windowId(10_000, 10), 1);
  assert.equal(windowId(19_999, 10), 1);
  assert.equal(windowId(20_000, 10), 2);
});

test("decide allows counts up to the max", () => {
  assert.deepEqual(decide(1, 2), { allowed: true, remaining: 1 });
  assert.deepEqual(decide(2, 2), { allowed: true, remaining: 0 });
  assert.deepEqual(decide(3, 2), { allowed: false, remaining: 0 });
});
