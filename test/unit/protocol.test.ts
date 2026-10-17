import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../../src/errors.js";
import { parseClientFrame } from "../../src/ws/protocol.js";

const roomId = "11111111-1111-4111-8111-111111111111";

test("parseClientFrame accepts each client frame", () => {
  assert.deepEqual(parseClientFrame({ type: "join", roomId }, 100), { type: "join", roomId });
  assert.deepEqual(parseClientFrame({ type: "leave", roomId }, 100), { type: "leave", roomId });
  assert.deepEqual(
    parseClientFrame({ type: "message", roomId, body: " hello ", clientMsgId: "abc_1" }, 100),
    { type: "message", roomId, body: "hello", clientMsgId: "abc_1" },
  );
  assert.deepEqual(parseClientFrame({ type: "typing", roomId, isTyping: true }, 100), {
    type: "typing",
    roomId,
    isTyping: true,
  });
  assert.deepEqual(parseClientFrame({ type: "read", roomId, messageId: "15" }, 100), {
    type: "read",
    roomId,
    messageId: "15",
  });
  assert.deepEqual(parseClientFrame({ type: "resume", roomId, after: "cursor" }, 100), {
    type: "resume",
    roomId,
    after: "cursor",
  });
});

test("parseClientFrame rejects invalid frames", () => {
  assert.throws(() => parseClientFrame({ type: "message", roomId, body: "   ", clientMsgId: "a" }, 100), AppError);
  assert.throws(() => parseClientFrame({ type: "message", roomId, body: "hi", clientMsgId: "bad id" }, 100), AppError);
  assert.throws(() => parseClientFrame({ type: "typing", roomId, isTyping: "yes" }, 100), AppError);
  assert.throws(() => parseClientFrame({ type: "nope" }, 100), (err: unknown) => {
    return err instanceof AppError && err.code === "unknown_type";
  });
  assert.throws(() => parseClientFrame([], 100), AppError);
});
