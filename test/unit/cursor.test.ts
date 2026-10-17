import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCursor, encodeCursor, resolveLimit, takePage } from "../../src/chat/cursor.js";
import { AppError } from "../../src/errors.js";

test("cursors round-trip a message id", () => {
  assert.equal(decodeCursor(encodeCursor("42")), "42");
});

test("decodeCursor rejects garbage", () => {
  assert.throws(() => decodeCursor("@@@"), AppError);
  const wrongVersion = Buffer.from(JSON.stringify({ v: 2, id: "1" }), "utf8").toString("base64url");
  assert.throws(() => decodeCursor(wrongVersion), AppError);
});

test("resolveLimit uses the fallback and rejects out of range values", () => {
  assert.equal(resolveLimit(undefined, 50, 100), 50);
  assert.equal(resolveLimit("25", 50, 100), 25);
  assert.throws(() => resolveLimit("0", 50, 100), AppError);
  assert.throws(() => resolveLimit("101", 50, 100), AppError);
  assert.throws(() => resolveLimit("1.5", 50, 100), AppError);
});

test("takePage reports another page when the extra row is present", () => {
  assert.deepEqual(takePage([1, 2, 3], 2), { rows: [1, 2], hasMore: true });
  assert.deepEqual(takePage([1, 2], 2), { rows: [1, 2], hasMore: false });
});
