import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { dummyPasswordHash, hashPassword, verifyPassword } from "../auth/password.js";
import { signJwt, verifyJwt } from "../auth/jwt.js";
import { issueTicket } from "../auth/tickets.js";
import type { RateLimiter } from "../chat/ratelimit.js";
import { resolveLimit } from "../chat/cursor.js";
import type { Config } from "../config.js";
import { listMessagesBefore } from "../db/messages.js";
import { listReceipts } from "../db/receipts.js";
import {
  createRoom,
  getOrCreateDm,
  joinRoom,
  leaveRoom,
  listRoomsForUser,
  requireRoomMember,
} from "../db/rooms.js";
import { createUser, findUserById, findUserByUsername } from "../db/users.js";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import type { PublicUser } from "../types.js";
import { isRecord, parseCredentials, validateRoomName, validateUsername, validateUuid } from "../validation.js";
import { resolveRoute, type Route } from "./router.js";

type Deps = {
  config: Config;
  pool: Pool;
  redis: Redis;
  limiter: RateLimiter;
};

const routes: readonly Route[] = [
  { method: "POST", pattern: "/api/register", auth: false },
  { method: "POST", pattern: "/api/login", auth: false },
  { method: "POST", pattern: "/api/ws-ticket", auth: true },
  { method: "GET", pattern: "/api/me", auth: true },
  { method: "POST", pattern: "/api/rooms", auth: true },
  { method: "GET", pattern: "/api/rooms", auth: true },
  { method: "POST", pattern: "/api/rooms/:roomId/join", auth: true },
  { method: "POST", pattern: "/api/rooms/:roomId/leave", auth: true },
  { method: "GET", pattern: "/api/rooms/:roomId/messages", auth: true },
  { method: "GET", pattern: "/api/rooms/:roomId/receipts", auth: true },
  { method: "POST", pattern: "/api/dm", auth: true },
  { method: "GET", pattern: "/health", auth: false },
];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(html);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"];
  if (!type || !type.startsWith("application/json")) {
    throw new AppError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > 64 * 1024) {
      throw new AppError(413, "payload_too_large", "Request body is too large");
    }
    chunks.push(buf);
  }
  if (size === 0) {
    throw new AppError(400, "invalid_json", "Expected JSON body");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AppError(400, "invalid_json", "Expected JSON body");
  }
}

function readBearer(header: string | undefined): string {
  if (!header) {
    throw new AppError(401, "unauthorized", "Missing bearer token");
  }
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  const token = match?.[1];
  if (!token) {
    throw new AppError(401, "unauthorized", "Missing bearer token");
  }
  return token;
}

function authenticate(config: Config, header: string | undefined): PublicUser {
  const claims = verifyJwt(readBearer(header), config.jwtSecret);
  return { id: claims.sub, username: claims.username };
}

async function limitAuth(deps: Deps, req: IncomingMessage): Promise<void> {
  const ip = req.socket.remoteAddress ?? "unknown";
  const decision = await deps.limiter.consume(
    `auth:${ip}`,
    deps.config.authRateLimitMax,
    deps.config.authRateLimitWindowSeconds,
  );
  if (!decision.allowed) {
    throw new AppError(429, "rate_limited", "Too many attempts");
  }
}

export async function loadClientHtml(staticDir: string): Promise<string> {
  return readFile(path.join(staticDir, "index.html"), "utf8");
}

export function createHttpServer(deps: Deps, html: string): Server {
  return createServer((req, res) => {
    void handle(deps, html, req, res).catch((err: unknown) => {
      if (err instanceof AppError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
        return;
      }
      log.error("request failed", err, { path: req.url });
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: "internal", message: "Internal error" } });
      } else {
        res.end();
      }
    });
  });
}

async function handle(deps: Deps, html: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    sendHtml(res, html);
    return;
  }
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  const resolved = resolveRoute(routes, req.method ?? "GET", url.pathname);
  if (resolved.kind === "not_found") {
    sendJson(res, 404, { error: { code: "not_found", message: "Not found" } });
    return;
  }
  if (resolved.kind === "method_not_allowed") {
    sendJson(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
    return;
  }
  const user = resolved.route.auth
    ? authenticate(deps.config, req.headers.authorization)
    : null;
  switch (resolved.route.pattern) {
    case "/api/register":
      await register(deps, req, res);
      return;
    case "/api/login":
      await login(deps, req, res);
      return;
    case "/api/ws-ticket":
      await ticket(deps, user, res);
      return;
    case "/api/me":
      await me(deps, user, res);
      return;
    case "/api/rooms":
      if (resolved.route.method === "POST") {
        await postRoom(deps, user, req, res);
        return;
      }
      await getRooms(deps, user, res);
      return;
    case "/api/rooms/:roomId/join":
      await postJoin(deps, user, resolved.params.roomId, res);
      return;
    case "/api/rooms/:roomId/leave":
      await postLeave(deps, user, resolved.params.roomId, res);
      return;
    case "/api/rooms/:roomId/messages":
      await getMessages(deps, user, resolved.params.roomId, url, res);
      return;
    case "/api/rooms/:roomId/receipts":
      await getReceipts(deps, user, resolved.params.roomId, res);
      return;
    case "/api/dm":
      await postDm(deps, user, req, res);
      return;
    case "/health":
      await health(deps, res);
      return;
    default:
      sendJson(res, 404, { error: { code: "not_found", message: "Not found" } });
  }
}

function requireUser(user: PublicUser | null): PublicUser {
  if (!user) {
    throw new AppError(401, "unauthorized", "Missing bearer token");
  }
  return user;
}

async function register(deps: Deps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  await limitAuth(deps, req);
  const credentials = parseCredentials(await readJson(req));
  const passwordHash = await hashPassword(credentials.password);
  const user = await createUser(deps.pool, credentials.username, passwordHash);
  const token = signJwt(userToClaims(user), deps.config.jwtSecret, deps.config.jwtTtlSeconds);
  sendJson(res, 201, { token, user });
}

async function login(deps: Deps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  await limitAuth(deps, req);
  const credentials = parseCredentials(await readJson(req));
  const existing = await findUserByUsername(deps.pool, credentials.username);
  const hash = existing?.passwordHash ?? (await dummyPasswordHash());
  const matches = await verifyPassword(credentials.password, hash);
  if (!existing || !matches) {
    throw new AppError(401, "invalid_credentials", "Invalid username or password");
  }
  const user = { id: existing.id, username: existing.username };
  const token = signJwt(userToClaims(user), deps.config.jwtSecret, deps.config.jwtTtlSeconds);
  sendJson(res, 200, { token, user });
}

async function ticket(deps: Deps, user: PublicUser | null, res: ServerResponse): Promise<void> {
  const current = requireUser(user);
  const value = await issueTicket(deps.redis, current);
  sendJson(res, 200, { ticket: value });
}

async function me(deps: Deps, user: PublicUser | null, res: ServerResponse): Promise<void> {
  const current = requireUser(user);
  const fresh = await findUserById(deps.pool, current.id);
  if (!fresh) {
    throw new AppError(401, "unauthorized", "Unknown user");
  }
  sendJson(res, 200, { user: fresh });
}

async function postRoom(
  deps: Deps,
  user: PublicUser | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const current = requireUser(user);
  const body = await readJson(req);
  if (!isRecord(body)) {
    throw new AppError(400, "invalid_body", "Expected an object");
  }
  const room = await createRoom(deps.pool, validateRoomName(body.name), current.id);
  sendJson(res, 201, { room });
}

async function getRooms(deps: Deps, user: PublicUser | null, res: ServerResponse): Promise<void> {
  const current = requireUser(user);
  const rooms = await listRoomsForUser(deps.pool, current.id);
  sendJson(res, 200, { rooms });
}

async function postJoin(
  deps: Deps,
  user: PublicUser | null,
  roomId: string | undefined,
  res: ServerResponse,
): Promise<void> {
  const current = requireUser(user);
  const room = await joinRoom(deps.pool, validateUuid(roomId, "invalid_room"), current.id);
  sendJson(res, 200, { room });
}

async function postLeave(
  deps: Deps,
  user: PublicUser | null,
  roomId: string | undefined,
  res: ServerResponse,
): Promise<void> {
  const current = requireUser(user);
  await leaveRoom(deps.pool, validateUuid(roomId, "invalid_room"), current.id);
  sendJson(res, 200, { ok: true });
}

async function getMessages(
  deps: Deps,
  user: PublicUser | null,
  roomIdRaw: string | undefined,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const current = requireUser(user);
  const roomId = validateUuid(roomIdRaw, "invalid_room");
  await requireRoomMember(deps.pool, roomId, current.id);
  const limit = resolveLimit(
    url.searchParams.get("limit"),
    deps.config.historyDefaultLimit,
    deps.config.historyMaxLimit,
  );
  const before = url.searchParams.get("before");
  const page = await listMessagesBefore(deps.pool, roomId, before, limit);
  sendJson(res, 200, page);
}

async function getReceipts(
  deps: Deps,
  user: PublicUser | null,
  roomIdRaw: string | undefined,
  res: ServerResponse,
): Promise<void> {
  const current = requireUser(user);
  const roomId = validateUuid(roomIdRaw, "invalid_room");
  await requireRoomMember(deps.pool, roomId, current.id);
  const receipts = await listReceipts(deps.pool, roomId);
  sendJson(res, 200, { receipts });
}

async function postDm(
  deps: Deps,
  user: PublicUser | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const current = requireUser(user);
  const body = await readJson(req);
  if (!isRecord(body)) {
    throw new AppError(400, "invalid_body", "Expected an object");
  }
  const username = validateUsername(body.username);
  const other = await findUserByUsername(deps.pool, username);
  if (!other) {
    throw new AppError(404, "not_found", "User not found");
  }
  const room = await getOrCreateDm(deps.pool, current.id, other.id);
  sendJson(res, 200, { room: { ...room, name: other.username } });
}

async function health(deps: Deps, res: ServerResponse): Promise<void> {
  const postgres = await probe(async () => {
    await deps.pool.query("SELECT 1");
  });
  const redis = await probe(async () => {
    const pong = await deps.redis.ping();
    if (pong !== "PONG") {
      throw new Error("unexpected ping reply");
    }
  });
  const ok = postgres === "up" && redis === "up";
  sendJson(res, ok ? 200 : 503, { ok, postgres, redis });
}

async function probe(fn: () => Promise<void>): Promise<"up" | "down"> {
  try {
    await fn();
    return "up";
  } catch {
    return "down";
  }
}

function userToClaims(user: PublicUser): { sub: string; username: string } {
  return { sub: user.id, username: user.username };
}
