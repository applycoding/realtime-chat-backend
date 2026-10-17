import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Redis } from "ioredis";
import pg from "pg";
import { createApp, type App } from "../../src/server.js";
import {
  api,
  ChatClient,
  cursorFor,
  integrationConfig,
  joinRoom,
  messageOf,
  openChat,
  register,
  username,
} from "./harness.js";

// Flushes the Redis database at REDIS_URL. Point this file at a disposable instance.
let app: App;
let pool: pg.Pool;
let redis: Redis;

before(async () => {
  const config = integrationConfig();
  pool = new pg.Pool({ connectionString: config.databaseUrl });
  redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  app = await createApp(config);
  await app.listen();
});

after(async () => {
  await app?.close();
  await redis?.quit();
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE read_receipts, messages, room_members, dm_pairs, rooms, users RESTART IDENTITY CASCADE",
  );
  await redis.flushdb();
});

test("health reports postgres and redis", async () => {
  const health = await api<{ ok: boolean; postgres: string; redis: string }>(app.port, null, "GET", "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, postgres: "up", redis: "up" });
});

test("register, login, and rejected credentials", async () => {
  const name = username("ada");
  const created = await register(app.port, name);
  const me = await api<{ user: { username: string } }>(app.port, created.token, "GET", "/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, name);

  const duplicate = await api(app.port, null, "POST", "/api/register", {
    username: name,
    password: "test-password",
  });
  assert.equal(duplicate.status, 409);

  const bad = await api(app.port, null, "POST", "/api/login", {
    username: name,
    password: "not-the-password",
  });
  assert.equal(bad.status, 401);

  const missing = await api(app.port, null, "GET", "/api/me");
  assert.equal(missing.status, 401);
});

test("members can page history with a cursor", async () => {
  const owner = await register(app.port, username("owner"));
  const guest = await register(app.port, username("guest"));
  const created = await api<{ room: { id: string } }>(app.port, owner.token, "POST", "/api/rooms", {
    name: "general",
  });
  assert.equal(created.status, 201);
  const roomId = created.body.room.id;

  const denied = await api(app.port, guest.token, "GET", `/api/rooms/${roomId}/messages`);
  assert.equal(denied.status, 403);
  const joined = await api(app.port, guest.token, "POST", `/api/rooms/${roomId}/join`);
  assert.equal(joined.status, 200);

  const client = await openChat(app.port, owner.token);
  try {
    await joinRoom(client, roomId);
    for (const body of ["m1", "m2", "m3", "m4", "m5"]) {
      client.send({ type: "message", roomId, body, clientMsgId: body });
      await client.expect((frame) => frame.type === "message" && messageOf(frame).body === body);
    }
  } finally {
    await client.close();
  }

  const loadPage = async (before: string | null) => {
    const suffix = before === null ? "" : `&before=${encodeURIComponent(before)}`;
    return api<{ messages: Array<{ body: string }>; nextCursor: string | null }>(
      app.port,
      owner.token,
      "GET",
      `/api/rooms/${roomId}/messages?limit=2${suffix}`,
    );
  };
  const pages: string[][] = [];
  let beforeCursor: string | null = null;
  for (;;) {
    const page = await loadPage(beforeCursor);
    assert.equal(page.status, 200);
    pages.push(page.body.messages.map((message) => message.body));
    if (page.body.nextCursor === null) {
      break;
    }
    beforeCursor = page.body.nextCursor;
  }
  assert.deepEqual(pages, [["m4", "m5"], ["m2", "m3"], ["m1"]]);
});

test("a reconnect replays messages after the cursor", async () => {
  const roomId = await sharedRoom();
  const ada = await register(app.port, username("ada"));
  const grace = await register(app.port, username("grace"));
  await api(app.port, ada.token, "POST", `/api/rooms/${roomId}/join`);
  await api(app.port, grace.token, "POST", `/api/rooms/${roomId}/join`);

  const writer = await openChat(app.port, ada.token);
  const reader = await openChat(app.port, grace.token);
  let replayed = "";
  try {
    await joinRoom(writer, roomId);
    await joinRoom(reader, roomId);
    writer.send({ type: "message", roomId, body: "one", clientMsgId: "one" });
    await reader.expect((frame) => frame.type === "message" && messageOf(frame).body === "one");
    writer.send({ type: "message", roomId, body: "two", clientMsgId: "two" });
    const second = await reader.expect((frame) => frame.type === "message" && messageOf(frame).body === "two");
    replayed = messageOf(second).id;
  } finally {
    await reader.close();
  }

  writer.send({ type: "message", roomId, body: "three", clientMsgId: "three" });
  await writer.expect((frame) => frame.type === "message" && messageOf(frame).body === "three");

  const resumed = await openChat(app.port, grace.token);
  try {
    resumed.send({ type: "resume", roomId, after: cursorFor(replayed) });
    const replay = await resumed.expect((frame) => frame.type === "replay" && frame.roomId === roomId);
    const messages = replay.messages;
    assert.ok(Array.isArray(messages));
    assert.deepEqual(
      messages.map((message) => (message as { body: string }).body),
      ["three"],
    );
    assert.equal(replay.hasMore, false);
  } finally {
    await resumed.close();
    await writer.close();
  }
});

test("typing, read receipts, and idempotent sends", async () => {
  const roomId = await sharedRoom();
  const ada = await register(app.port, username("ada"));
  const grace = await register(app.port, username("grace"));
  await api(app.port, ada.token, "POST", `/api/rooms/${roomId}/join`);
  await api(app.port, grace.token, "POST", `/api/rooms/${roomId}/join`);
  const writer = await openChat(app.port, ada.token);
  const reader = await openChat(app.port, grace.token);
  try {
    await joinRoom(writer, roomId);
    await joinRoom(reader, roomId);
    writer.send({ type: "message", roomId, body: "hello", clientMsgId: "same" });
    const first = await reader.expect((frame) => frame.type === "message");
    await writer.expect((frame) => frame.type === "message" && messageOf(frame).id === messageOf(first).id);
    writer.send({ type: "message", roomId, body: "hello again", clientMsgId: "same" });
    await writer.expect((frame) => frame.type === "message" && messageOf(frame).id === messageOf(first).id);
    writer.send({ type: "typing", roomId, isTyping: true });
    const typing = await reader.expect((frame) => frame.type === "typing");
    assert.equal(typing.username, ada.user.username);
    assert.equal(reader.frames.some((frame) => frame.type === "message"), false);

    reader.send({ type: "read", roomId, messageId: messageOf(first).id });
    const receipt = await writer.expect((frame) => frame.type === "read");
    assert.equal(receipt.userId, grace.user.id);
    assert.equal(receipt.messageId, messageOf(first).id);

    const stored = await api<{ receipts: Array<{ userId: string; messageId: string }> }>(
      app.port,
      ada.token,
      "GET",
      `/api/rooms/${roomId}/receipts`,
    );
    assert.equal(stored.status, 200);
    assert.ok(stored.body.receipts.some((item) => item.userId === grace.user.id && item.messageId === messageOf(first).id));
  } finally {
    await writer.close();
    await reader.close();
  }

  const history = await api<{ messages: unknown[] }>(app.port, ada.token, "GET", `/api/rooms/${roomId}/messages`);
  assert.equal(history.body.messages.length, 1);
});

test("direct messages are private to the pair", async () => {
  const ada = await register(app.port, username("ada"));
  const grace = await register(app.port, username("grace"));
  const self = await api(app.port, ada.token, "POST", "/api/dm", { username: ada.user.username });
  assert.equal(self.status, 400);
  const opened = await api<{ room: { id: string; kind: string; name: string } }>(app.port, ada.token, "POST", "/api/dm", {
    username: grace.user.username,
  });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.room.kind, "dm");
  assert.equal(opened.body.room.name, grace.user.username);
  const again = await api<{ room: { id: string } }>(app.port, grace.token, "POST", "/api/dm", {
    username: ada.user.username,
  });
  assert.equal(again.body.room.id, opened.body.room.id);

  const writer = await openChat(app.port, ada.token);
  const reader = await openChat(app.port, grace.token);
  try {
    await joinRoom(writer, opened.body.room.id);
    await joinRoom(reader, opened.body.room.id);
    writer.send({ type: "message", roomId: opened.body.room.id, body: "ping", clientMsgId: "dm1" });
    const received = await reader.expect((frame) => frame.type === "message");
    assert.equal(messageOf(received).body, "ping");
  } finally {
    await writer.close();
    await reader.close();
  }
});

test("presence goes offline after the last socket closes", async () => {
  const roomId = await sharedRoom();
  const ada = await register(app.port, username("ada"));
  const grace = await register(app.port, username("grace"));
  await api(app.port, ada.token, "POST", `/api/rooms/${roomId}/join`);
  await api(app.port, grace.token, "POST", `/api/rooms/${roomId}/join`);
  const first = await openChat(app.port, ada.token);
  const second = await openChat(app.port, ada.token);
  const reader = await openChat(app.port, grace.token);
  try {
    await joinRoom(first, roomId);
    await joinRoom(second, roomId);
    const joined = await joinRoom(reader, roomId);
    const online = joined.onlineUsers;
    assert.ok(Array.isArray(online));
    assert.ok(online.some((entry) => (entry as { id: string }).id === ada.user.id));

    await first.close();
    second.send({ type: "typing", roomId, isTyping: true });
    await reader.expect((frame) => frame.type === "typing" && frame.userId === ada.user.id);
    assert.equal(
      reader.frames.some((frame) => frame.type === "presence" && frame.status === "offline"),
      false,
    );

    await second.close();
    const offline = await reader.expect((frame) => frame.type === "presence" && frame.userId === ada.user.id);
    assert.equal(offline.status, "offline");
  } finally {
    await first.close();
    await second.close();
    await reader.close();
  }
});

test("two gateway processes fan out a room message", async () => {
  const second = await createApp(integrationConfig());
  await second.listen();
  const clients: ChatClient[] = [];
  try {
    const ada = await register(app.port, username("ada"));
    const grace = await register(second.port, username("grace"));
    const created = await api<{ room: { id: string } }>(app.port, ada.token, "POST", "/api/rooms", { name: "fanout" });
    const roomId = created.body.room.id;
    await api(second.port, grace.token, "POST", `/api/rooms/${roomId}/join`);
    const writer = await openChat(app.port, ada.token);
    const reader = await openChat(second.port, grace.token);
    clients.push(writer, reader);
    await joinRoom(writer, roomId);
    await joinRoom(reader, roomId);
    writer.send({ type: "message", roomId, body: "across", clientMsgId: "fan1" });
    const received = await reader.expect((frame) => frame.type === "message");
    assert.equal(messageOf(received).body, "across");
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await second.close();
  }
});

test("message rate limit rejects the burst and does not persist it", async () => {
  const limited = await createApp(integrationConfig({ messageRateLimitMax: 2, messageRateLimitWindowSeconds: 60 }));
  await limited.listen();
  let client: ChatClient | null = null;
  try {
    const ada = await register(limited.port, username("ada"));
    const created = await api<{ room: { id: string } }>(limited.port, ada.token, "POST", "/api/rooms", {
      name: "limits",
    });
    const roomId = created.body.room.id;
    client = await openChat(limited.port, ada.token);
    await joinRoom(client, roomId);
    client.send({ type: "message", roomId, body: "one", clientMsgId: "one" });
    client.send({ type: "message", roomId, body: "two", clientMsgId: "two" });
    await client.expect((frame) => frame.type === "message" && messageOf(frame).body === "one");
    await client.expect((frame) => frame.type === "message" && messageOf(frame).body === "two");
    client.send({ type: "message", roomId, body: "three", clientMsgId: "three" });
    const rejected = await client.expect((frame) => frame.type === "error");
    assert.equal(rejected.code, "rate_limited");
    const history = await api<{ messages: Array<{ body: string }> }>(
      limited.port,
      ada.token,
      "GET",
      `/api/rooms/${roomId}/messages`,
    );
    assert.deepEqual(
      history.body.messages.map((message) => message.body),
      ["one", "two"],
    );
  } finally {
    await client?.close();
    await limited.close();
  }
});

async function sharedRoom(): Promise<string> {
  const owner = await register(app.port, username("room"));
  const created = await api<{ room: { id: string } }>(app.port, owner.token, "POST", "/api/rooms", {
    name: "shared",
  });
  assert.equal(created.status, 201);
  return created.body.room.id;
}
