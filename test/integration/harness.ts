import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { encodeCursor } from "../../src/chat/cursor.js";
import { loadConfig, type Config } from "../../src/config.js";

export type Frame = { type: string } & Record<string, unknown>;

export type Auth = {
  token: string;
  user: { id: string; username: string };
};

export function integrationConfig(overrides: Partial<Config> = {}): Config {
  const secret = process.env.JWT_SECRET;
  return {
    ...loadConfig({
      ...process.env,
      PORT: "0",
      JWT_SECRET: secret && secret.length >= 16 ? secret : "integration-test-secret",
      AUTH_RATE_LIMIT_MAX: "1000",
      MESSAGE_RATE_LIMIT_MAX: "100",
      TYPING_RATE_LIMIT_MAX: "100",
    }),
    port: 0,
    ...overrides,
  };
}

export function username(prefix: string): string {
  return `${prefix}_${randomBytes(3).toString("hex")}`;
}

export async function api<T>(
  port: number,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

export async function register(port: number, name: string): Promise<Auth> {
  const result = await api<Auth>(port, null, "POST", "/api/register", {
    username: name,
    password: "test-password",
  });
  assert.equal(result.status, 201);
  return result.body;
}

export class ChatClient {
  readonly frames: Frame[] = [];
  readonly opened: Promise<void>;

  constructor(private readonly ws: WebSocket) {
    this.opened = new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    ws.on("message", (data) => {
      this.frames.push(JSON.parse(String(data)) as Frame);
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  async expect(predicate: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    const started = Date.now();
    for (;;) {
      const index = this.frames.findIndex(predicate);
      if (index >= 0) {
        const frame = this.frames.splice(index, 1)[0];
        if (!frame) {
          throw new Error("missing frame");
        }
        return frame;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timed out waiting for frame; pending=${JSON.stringify(this.frames)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

export async function openChat(port: number, token: string): Promise<ChatClient> {
  const issued = await api<{ ticket: string }>(port, token, "POST", "/api/ws-ticket");
  assert.equal(issued.status, 200);
  const client = new ChatClient(new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${issued.body.ticket}`));
  await client.opened;
  await client.expect((frame) => frame.type === "ready");
  return client;
}

export function messageOf(frame: Frame): { id: string; body: string; senderId: string } {
  const message = frame.message;
  if (!message || typeof message !== "object") {
    throw new Error("expected a message frame");
  }
  const record = message as Record<string, unknown>;
  const { id, body, senderId } = record;
  if (typeof id !== "string" || typeof body !== "string" || typeof senderId !== "string") {
    throw new Error("expected message id, body, and senderId");
  }
  return { id, body, senderId };
}

export function cursorFor(messageId: string): string {
  return encodeCursor(messageId);
}

export async function joinRoom(client: ChatClient, roomId: string): Promise<Frame> {
  client.send({ type: "join", roomId });
  return client.expect((frame) => frame.type === "joined" && frame.roomId === roomId);
}
