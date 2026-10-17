import { AppError } from "../errors.js";
import { isRecord } from "../validation.js";

export function encodeCursor(messageId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, id: messageId }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new AppError(400, "invalid_cursor", "Invalid cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new AppError(400, "invalid_cursor", "Invalid cursor");
  }
  if (
    !isRecord(parsed) ||
    parsed.v !== 1 ||
    typeof parsed.id !== "string" ||
    !/^[0-9]{1,20}$/.test(parsed.id)
  ) {
    throw new AppError(400, "invalid_cursor", "Invalid cursor");
  }
  return parsed.id;
}

export function resolveLimit(input: unknown, fallback: number, max: number): number {
  if (input === undefined || input === null || input === "") {
    return fallback;
  }
  if (typeof input !== "string" && typeof input !== "number") {
    throw new AppError(400, "invalid_limit", `Limit must be an integer from 1 to ${max}`);
  }
  const value = typeof input === "number" ? input : Number(input);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new AppError(400, "invalid_limit", `Limit must be an integer from 1 to ${max}`);
  }
  return value;
}

export function takePage<T>(rows: readonly T[], limit: number): { rows: T[]; hasMore: boolean } {
  if (rows.length > limit) {
    return { rows: rows.slice(0, limit), hasMore: true };
  }
  return { rows: rows.slice(), hasMore: false };
}
