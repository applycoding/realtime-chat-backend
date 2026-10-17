import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN);
  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length < 8 || password.length > 128) {
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 6) {
    return false;
  }
  const [scheme, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  if (
    scheme !== "scrypt" ||
    nRaw !== String(SCRYPT_N) ||
    rRaw !== String(SCRYPT_R) ||
    pRaw !== String(SCRYPT_P) ||
    !saltB64 ||
    !hashB64
  ) {
    return false;
  }
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(hashB64, "base64url");
  if (salt.length !== 16 || expected.length !== KEY_LEN) {
    return false;
  }
  const actual = await scryptAsync(password, salt, expected.length);
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;

export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword("dummy-password");
  return dummyHash;
}
