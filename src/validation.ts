import { AppError } from "./errors.js";

const USERNAME = /^[a-zA-Z0-9_]{3,32}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_ID = /^[0-9]{1,20}$/;
const CLIENT_MSG_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateUsername(input: unknown): string {
  if (typeof input !== "string" || !USERNAME.test(input)) {
    throw new AppError(
      400,
      "invalid_username",
      "Username must be 3-32 characters: letters, digits, underscore",
    );
  }
  return input.toLowerCase();
}

export function validatePassword(input: unknown): string {
  if (typeof input !== "string" || input.length < 8 || input.length > 128) {
    throw new AppError(400, "invalid_password", "Password must be 8-128 characters");
  }
  return input;
}

export function validateRoomName(input: unknown): string {
  if (typeof input !== "string") {
    throw new AppError(400, "invalid_name", "Room name must be 1-80 characters");
  }
  const name = input.trim();
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001F\u007F]/.test(name)) {
    throw new AppError(400, "invalid_name", "Room name must be 1-80 characters");
  }
  return name;
}

export function validateUuid(input: unknown, code = "invalid_id"): string {
  if (typeof input !== "string" || !UUID_RE.test(input)) {
    throw new AppError(400, code, "Expected a UUID");
  }
  return input.toLowerCase();
}

export function validateMessageId(input: unknown): string {
  if (typeof input !== "string" || !MESSAGE_ID.test(input)) {
    throw new AppError(400, "invalid_message_id", "Expected a message id");
  }
  return input;
}

export function validateClientMsgId(input: unknown): string {
  if (typeof input !== "string" || !CLIENT_MSG_ID.test(input)) {
    throw new AppError(
      400,
      "invalid_client_msg_id",
      "clientMsgId must be 1-64 characters: letters, digits, underscore, hyphen",
    );
  }
  return input;
}

export function parseCredentials(body: unknown): { username: string; password: string } {
  if (!isRecord(body)) {
    throw new AppError(400, "invalid_body", "Expected an object");
  }
  return {
    username: validateUsername(body.username),
    password: validatePassword(body.password),
  };
}
