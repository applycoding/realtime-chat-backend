import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "../../src/auth/password.js";

test("hashPassword verifies the same password and rejects a different one", async () => {
  const stored = await hashPassword("correct-horse");
  assert.equal(await verifyPassword("correct-horse", stored), true);
  assert.equal(await verifyPassword("wrong-horse", stored), false);
});

test("verifyPassword rejects malformed stored hashes without throwing", async () => {
  assert.equal(await verifyPassword("correct-horse", "not-a-hash"), false);
  assert.equal(await verifyPassword("correct-horse", "scrypt$1$1$1$aa$bb"), false);
  assert.equal(await verifyPassword("short", "scrypt$1$1$1$aa$bb"), false);
});
