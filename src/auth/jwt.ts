import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors.js";
import { isRecord } from "../validation.js";

export type JwtClaims = {
  sub: string;
  username: string;
};

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function b64urlDecode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppError(401, "invalid_token", "Invalid token");
  }
  return Buffer.from(value, "base64url");
}

function readJson(value: string): unknown {
  try {
    return JSON.parse(b64urlDecode(value).toString("utf8")) as unknown;
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError(401, "invalid_token", "Invalid token");
  }
}

export function signJwt(
  claims: JwtClaims,
  secret: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSeconds;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ sub: claims.sub, username: claims.username, iat, exp }),
  );
  const signature = b64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

export function verifyJwt(token: string, secret: string, nowMs = Date.now()): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AppError(401, "invalid_token", "Invalid token");
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new AppError(401, "invalid_token", "Invalid token");
  }
  const header = readJson(headerPart);
  if (!isRecord(header) || header.alg !== "HS256" || header.typ !== "JWT") {
    throw new AppError(401, "invalid_token", "Invalid token");
  }
  const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
  const actual = b64urlDecode(signaturePart);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError(401, "invalid_token", "Invalid token");
  }
  const payload = readJson(payloadPart);
  if (
    !isRecord(payload) ||
    typeof payload.sub !== "string" ||
    typeof payload.username !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp <= payload.iat
  ) {
    throw new AppError(401, "invalid_token", "Invalid token");
  }
  if (payload.exp * 1000 <= nowMs) {
    throw new AppError(401, "invalid_token", "Token expired");
  }
  return { sub: payload.sub, username: payload.username };
}
