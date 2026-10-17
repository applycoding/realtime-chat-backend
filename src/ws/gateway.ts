import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { consumeTicket } from "../auth/tickets.js";
import type { EventBus, PresenceBusEvent, RoomBusEvent } from "../chat/bus.js";
import type { PresenceStore } from "../chat/presence.js";
import type { RateLimiter } from "../chat/ratelimit.js";
import type { Config } from "../config.js";
import { findByClientMsgId, insertMessage, listMessagesAfter } from "../db/messages.js";
import { markRead } from "../db/receipts.js";
import { listMembers, listRoomIdsForUser, requireRoomMember } from "../db/rooms.js";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import { Mutex } from "../mutex.js";
import { assertNever, clientMsgIdFrom, parseClientFrame, type ServerFrame } from "./protocol.js";

type Connection = {
  id: string;
  userId: string;
  username: string;
  socket: WebSocket;
  rooms: Set<string>;
  alive: boolean;
  closed: boolean;
  heartbeat: NodeJS.Timeout;
  cleanup: Promise<void> | null;
  queue: Promise<void>;
};

export type GatewayDeps = {
  pool: Pool;
  redis: Redis;
  bus: EventBus;
  presence: PresenceStore;
  limiter: RateLimiter;
  config: Config;
};

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, Connection>();
  private readonly rooms = new Map<string, Set<Connection>>();
  private readonly roomLocks = new Map<string, Mutex>();
  private shuttingDown = false;

  constructor(private readonly deps: GatewayDeps) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  }

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });
    this.wss.on("connection", (socket, req) => {
      void this.accept(socket, req).catch((err: unknown) => {
        log.error("ws accept failed", err);
        this.sendRaw(socket, {
          type: "error",
          code: "internal",
          message: "Internal error",
        });
        socket.close(1011, "internal error");
      });
    });
  }

  handleRoomEvent(roomId: string, event: RoomBusEvent): void {
    const sockets = this.rooms.get(roomId);
    if (!sockets) {
      return;
    }
    for (const conn of [...sockets]) {
      switch (event.type) {
        case "message":
          this.send(conn, { type: "message", message: event.message });
          break;
        case "typing":
          if (conn.userId === event.userId) {
            break;
          }
          this.send(conn, event);
          break;
        case "read":
          this.send(conn, event);
          break;
        default:
          assertNever(event);
      }
    }
  }

  async handlePresence(event: PresenceBusEvent): Promise<void> {
    let roomIds: string[];
    try {
      roomIds = await listRoomIdsForUser(this.deps.pool, event.userId);
    } catch (err) {
      log.error("presence fanout failed", err);
      return;
    }
    const memberOf = new Set(roomIds);
    for (const [roomId, sockets] of this.rooms) {
      if (!memberOf.has(roomId)) {
        continue;
      }
      for (const conn of [...sockets]) {
        this.send(conn, event);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const conns = [...this.connections.values()];
    for (const conn of conns) {
      conn.socket.close(1001, "shutting down");
    }
    await Promise.all(conns.map((conn) => this.disconnect(conn)));
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  private async accept(socket: WebSocket, req: IncomingMessage): Promise<void> {
    if (this.shuttingDown) {
      socket.close(1001, "shutting down");
      return;
    }
    const ticket = new URL(req.url ?? "/", "http://localhost").searchParams.get("ticket");
    if (!ticket) {
      this.reject(socket, "unauthorized", "Missing ticket");
      return;
    }
    const user = await consumeTicket(this.deps.redis, ticket);
    if (!user) {
      this.reject(socket, "unauthorized", "Invalid ticket");
      return;
    }
    const conn: Connection = {
      id: randomUUID(),
      userId: user.id,
      username: user.username,
      socket,
      rooms: new Set(),
      alive: true,
      closed: false,
      cleanup: null,
      queue: Promise.resolve(),
      heartbeat: setInterval(() => {
        this.heartbeat(conn);
      }, this.deps.config.wsHeartbeatMs),
    };
    this.connections.set(conn.id, conn);
    socket.on("pong", () => {
      conn.alive = true;
    });
    socket.on("message", (data) => {
      conn.queue = conn.queue.then(() => this.onMessage(conn, data)).catch((err: unknown) => {
        log.error("ws frame failed", err, { userId: conn.userId });
      });
    });
    socket.on("close", () => {
      void this.disconnect(conn);
    });
    socket.on("error", (err) => {
      log.error("ws socket error", err, { userId: conn.userId });
    });
    const transition = await this.deps.presence.acquire(conn.userId, conn.id);
    if (transition === "online") {
      await this.deps.bus.publishPresence({
        type: "presence",
        userId: conn.userId,
        username: conn.username,
        status: "online",
      });
    }
    this.send(conn, { type: "ready", user: { id: conn.userId, username: conn.username } });
  }

  private heartbeat(conn: Connection): void {
    if (conn.closed) {
      return;
    }
    if (!conn.alive) {
      conn.socket.terminate();
      return;
    }
    conn.alive = false;
    conn.socket.ping();
    void this.deps.presence
      .refresh(conn.userId, conn.id)
      .then((status) => {
        if (status !== "online") {
          return undefined;
        }
        return this.deps.bus.publishPresence({
          type: "presence",
          userId: conn.userId,
          username: conn.username,
          status: "online",
        });
      })
      .catch((err: unknown) => {
        log.error("presence refresh failed", err, { userId: conn.userId });
      });
  }

  private async onMessage(conn: Connection, data: RawData): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(rawToString(data)) as unknown;
    } catch {
      this.send(conn, { type: "error", code: "invalid_json", message: "Expected JSON" });
      return;
    }
    try {
      const frame = parseClientFrame(raw, this.deps.config.messageMaxLength);
      switch (frame.type) {
        case "join":
          await this.join(conn, frame.roomId);
          break;
        case "leave":
          await this.leave(conn, frame.roomId);
          break;
        case "message":
          await this.sendMessage(conn, frame.roomId, frame.body, frame.clientMsgId);
          break;
        case "typing":
          await this.typing(conn, frame.roomId, frame.isTyping);
          break;
        case "read":
          await this.read(conn, frame.roomId, frame.messageId);
          break;
        case "resume":
          await this.resume(conn, frame.roomId, frame.after);
          break;
        default:
          assertNever(frame);
      }
    } catch (err) {
      const clientMsgId = clientMsgIdFrom(raw);
      if (err instanceof AppError) {
        this.send(conn, {
          type: "error",
          code: err.code,
          message: err.message,
          ...(clientMsgId ? { clientMsgId } : {}),
        });
        return;
      }
      log.error("ws frame failed", err, { userId: conn.userId });
      this.send(conn, {
        type: "error",
        code: "internal",
        message: "Internal error",
        ...(clientMsgId ? { clientMsgId } : {}),
      });
    }
  }

  private async join(conn: Connection, roomId: string): Promise<void> {
    await requireRoomMember(this.deps.pool, roomId, conn.userId);
    await this.attachToRoom(conn, roomId);
    const members = await listMembers(this.deps.pool, roomId);
    const onlineUsers = await this.deps.presence.onlineUsers(members);
    this.send(conn, { type: "joined", roomId, onlineUsers });
  }

  private async resume(conn: Connection, roomId: string, after: string): Promise<void> {
    await requireRoomMember(this.deps.pool, roomId, conn.userId);
    await this.attachToRoom(conn, roomId);
    const page = await listMessagesAfter(this.deps.pool, roomId, after, this.deps.config.replayLimit);
    this.send(conn, { type: "replay", roomId, messages: page.messages, hasMore: page.hasMore });
    const members = await listMembers(this.deps.pool, roomId);
    const onlineUsers = await this.deps.presence.onlineUsers(members);
    this.send(conn, { type: "joined", roomId, onlineUsers });
  }

  private async leave(conn: Connection, roomId: string): Promise<void> {
    await this.detachFromRoom(conn, roomId);
    this.send(conn, { type: "left", roomId });
  }

  private async sendMessage(
    conn: Connection,
    roomId: string,
    body: string,
    clientMsgId: string,
  ): Promise<void> {
    if (!conn.rooms.has(roomId)) {
      throw new AppError(400, "not_joined", "Join the room before sending");
    }
    await requireRoomMember(this.deps.pool, roomId, conn.userId);
    const existing = await findByClientMsgId(this.deps.pool, roomId, conn.userId, clientMsgId);
    if (existing) {
      this.send(conn, { type: "message", message: existing });
      return;
    }
    const decision = await this.deps.limiter.consume(
      `msg:${conn.userId}`,
      this.deps.config.messageRateLimitMax,
      this.deps.config.messageRateLimitWindowSeconds,
    );
    if (!decision.allowed) {
      throw new AppError(429, "rate_limited", "Too many messages");
    }
    const inserted = await insertMessage(this.deps.pool, {
      roomId,
      senderId: conn.userId,
      username: conn.username,
      body,
      clientMsgId,
    });
    if (inserted.duplicate) {
      this.send(conn, { type: "message", message: inserted.message });
      return;
    }
    await this.deps.bus.publishRoom(roomId, { type: "message", message: inserted.message });
  }

  private async typing(conn: Connection, roomId: string, isTyping: boolean): Promise<void> {
    if (!conn.rooms.has(roomId)) {
      return;
    }
    const decision = await this.deps.limiter.consume(
      `typing:${conn.userId}`,
      this.deps.config.typingRateLimitMax,
      this.deps.config.typingRateLimitWindowSeconds,
    );
    if (!decision.allowed) {
      return;
    }
    await this.deps.bus.publishRoom(roomId, {
      type: "typing",
      roomId,
      userId: conn.userId,
      username: conn.username,
      isTyping,
    });
  }

  private async read(conn: Connection, roomId: string, messageId: string): Promise<void> {
    if (!conn.rooms.has(roomId)) {
      throw new AppError(400, "not_joined", "Join the room before sending");
    }
    await requireRoomMember(this.deps.pool, roomId, conn.userId);
    const result = await markRead(this.deps.pool, roomId, conn.userId, messageId);
    if (result.status === "missing") {
      throw new AppError(404, "not_found", "Message not found");
    }
    if (result.status === "stale") {
      return;
    }
    await this.deps.bus.publishRoom(roomId, {
      type: "read",
      roomId,
      userId: conn.userId,
      messageId: result.messageId,
      readAt: result.readAt,
    });
  }

  private async attachToRoom(conn: Connection, roomId: string): Promise<void> {
    await this.lockFor(roomId).run(async () => {
      let sockets = this.rooms.get(roomId);
      if (!sockets) {
        await this.deps.bus.subscribeRoom(roomId);
        sockets = new Set();
        this.rooms.set(roomId, sockets);
      }
      sockets.add(conn);
      conn.rooms.add(roomId);
    });
  }

  private async detachFromRoom(conn: Connection, roomId: string): Promise<void> {
    await this.lockFor(roomId).run(async () => {
      const sockets = this.rooms.get(roomId);
      if (!sockets || !sockets.has(conn)) {
        return;
      }
      sockets.delete(conn);
      conn.rooms.delete(roomId);
      if (sockets.size === 0) {
        this.rooms.delete(roomId);
        await this.deps.bus.unsubscribeRoom(roomId);
      }
    });
  }

  private async disconnect(conn: Connection): Promise<void> {
    if (conn.cleanup) {
      return conn.cleanup;
    }
    conn.closed = true;
    conn.cleanup = this.cleanup(conn);
    return conn.cleanup;
  }

  private async cleanup(conn: Connection): Promise<void> {
    clearInterval(conn.heartbeat);
    this.connections.delete(conn.id);
    for (const roomId of [...conn.rooms]) {
      await this.detachFromRoom(conn, roomId);
    }
    try {
      const status = await this.deps.presence.release(conn.userId, conn.id);
      if (status === "offline") {
        await this.deps.bus.publishPresence({
          type: "presence",
          userId: conn.userId,
          username: conn.username,
          status: "offline",
        });
      }
    } catch (err) {
      log.error("presence release failed", err, { userId: conn.userId });
    }
  }

  private lockFor(roomId: string): Mutex {
    const existing = this.roomLocks.get(roomId);
    if (existing) {
      return existing;
    }
    const created = new Mutex();
    this.roomLocks.set(roomId, created);
    return created;
  }

  private reject(socket: WebSocket, code: string, message: string): void {
    this.sendRaw(socket, { type: "error", code, message });
    socket.close(4401, "unauthorized");
  }

  private send(conn: Connection, frame: ServerFrame): void {
    this.sendRaw(conn.socket, frame);
  }

  private sendRaw(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(frame));
  }
}

function rawToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
