import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { AppError } from "../../src/errors.js";
import { signJwt, verifyJwt } from "../../src/auth/jwt.js";

const secret = "test-secret-value";

test("signJwt and verifyJwt round-trip", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const token = signJwt({ sub: "user-1", username: "ada" }, secret, 60, now);
  assert.deepEqual(verifyJwt(token, secret, now + 1000), { sub: "user-1", username: "ada" });
});

test("verifyJwt rejects an expired token", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const token = signJwt({ sub: "user-1", username: "ada" }, secret, 10, now);
  assert.throws(
    () => verifyJwt(token, secret, now + 11_000),
    (err: unknown) => err instanceof AppError && err.code === "invalid_token",
  );
});

test("verifyJwt rejects a tampered signature", () => {
  const token = signJwt({ sub: "user-1", username: "ada" }, secret, 60);
  const [header, payload, signature] = token.split(".");
  assert.ok(header && payload && signature);
  const flipped = signature.slice(0, -1) + (signature.endsWith("a") ? "b" : "a");
  assert.throws(() => verifyJwt(`${header}.${payload}.${flipped}`, secret), AppError);
});

test("verifyJwt rejects alg none", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "user-1", username: "ada", iat: 1, exp: 4_000_000_000 }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  assert.throws(() => verifyJwt(`${header}.${payload}.${signature}`, secret), AppError);
});
