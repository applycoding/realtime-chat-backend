import { AppError } from "../errors.js";
import type { PublicMessage, PublicUser } from "../types.js";
import {
  isRecord,
  validateClientMsgId,
  validateMessageId,
  validateUuid,
} from "../validation.js";

export type ClientFrame =
  | { type: "join"; roomId: string }
  | { type: "leave"; roomId: string }
  | { type: "message"; roomId: string; body: string; clientMsgId: string }
  | { type: "typing"; roomId: string; isTyping: boolean }
  | { type: "read"; roomId: string; messageId: string }
  | { type: "resume"; roomId: string; after: string };

export type ServerFrame =
  | { type: "ready"; user: PublicUser }
  | { type: "joined"; roomId: string; onlineUsers: PublicUser[] }
  | { type: "left"; roomId: string }
  | { type: "message"; message: PublicMessage }
  | { type: "typing"; roomId: string; userId: string; username: string; isTyping: boolean }
  | { type: "read"; roomId: string; userId: string; messageId: string; readAt: string }
  | { type: "presence"; userId: string; username: string; status: "online" | "offline" }
  | { type: "replay"; roomId: string; messages: PublicMessage[]; hasMore: boolean }
  | { type: "error"; code: string; message: string; clientMsgId?: string };

export function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

export function parseClientFrame(raw: unknown, messageMaxLength: number): ClientFrame {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    throw new AppError(400, "invalid_frame", "Expected a frame object");
  }
  switch (raw.type) {
    case "join":
    case "leave":
      return { type: raw.type, roomId: validateUuid(raw.roomId, "invalid_room") };
    case "message": {
      if (typeof raw.body !== "string") {
        throw new AppError(400, "invalid_body", "Message body is required");
      }
      const body = raw.body.trim();
      if (body.length < 1 || body.length > messageMaxLength) {
        throw new AppError(
          400,
          "invalid_body",
          `Message body must be 1-${messageMaxLength} characters`,
        );
      }
      return {
        type: "message",
        roomId: validateUuid(raw.roomId, "invalid_room"),
        body,
        clientMsgId: validateClientMsgId(raw.clientMsgId),
      };
    }
    case "typing":
      if (typeof raw.isTyping !== "boolean") {
        throw new AppError(400, "invalid_frame", "isTyping must be a boolean");
      }
      return {
        type: "typing",
        roomId: validateUuid(raw.roomId, "invalid_room"),
        isTyping: raw.isTyping,
      };
    case "read":
      return {
        type: "read",
        roomId: validateUuid(raw.roomId, "invalid_room"),
        messageId: validateMessageId(raw.messageId),
      };
    case "resume":
      if (typeof raw.after !== "string" || raw.after.length < 1 || raw.after.length > 256) {
        throw new AppError(400, "invalid_cursor", "Invalid cursor");
      }
      return {
        type: "resume",
        roomId: validateUuid(raw.roomId, "invalid_room"),
        after: raw.after,
      };
    default:
      throw new AppError(400, "unknown_type", "Unknown frame type");
  }
}

export function clientMsgIdFrom(raw: unknown): string | undefined {
  if (!isRecord(raw) || typeof raw.clientMsgId !== "string") {
    return undefined;
  }
  return raw.clientMsgId;
}
