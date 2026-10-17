import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../../src/errors.js";
import { loadConfig } from "../../src/config.js";
import { orderUserPair } from "../../src/db/rooms.js";
import { parseCredentials, validateRoomName, validateUsername } from "../../src/validation.js";

const env = {
  DATABASE_URL: "postgres://chat:chat@127.0.0.1:5432/chat",
  REDIS_URL: "redis://127.0.0.1:6379",
  JWT_SECRET: "0123456789abcdef",
};

test("validateUsername lowercases a legal name", () => {
  assert.equal(validateUsername("Ada_Lovelace"), "ada_lovelace");
  assert.throws(() => validateUsername("no"), AppError);
  assert.throws(() => validateUsername("has-dash"), AppError);
});

test("parseCredentials and room names", () => {
  assert.deepEqual(parseCredentials({ username: "ada", password: "password1" }), {
    username: "ada",
    password: "password1",
  });
  assert.throws(() => parseCredentials({ username: "ada", password: "short" }), AppError);
  assert.equal(validateRoomName("  general  "), "general");
  assert.throws(() => validateRoomName("   "), AppError);
});

test("orderUserPair sorts ids and rejects a self pair", () => {
  assert.deepEqual(orderUserPair("b", "a"), ["a", "b"]);
  assert.throws(() => orderUserPair("a", "A"), AppError);
});

test("loadConfig applies defaults and rejects a short JWT secret", () => {
  const config = loadConfig(env);
  assert.equal(config.port, 3000);
  assert.equal(config.messageRateLimitMax, 30);
  assert.equal(config.historyDefaultLimit, 50);
  assert.throws(() => loadConfig({ ...env, JWT_SECRET: "too-short" }), /JWT_SECRET/);
  assert.throws(() => loadConfig({ ...env, PORT: "0" }), /PORT/);
});
