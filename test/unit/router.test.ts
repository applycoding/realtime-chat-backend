import assert from "node:assert/strict";
import { test } from "node:test";
import { matchPath, resolveRoute, type Route } from "../../src/http/router.js";

const routes: readonly Route[] = [
  { method: "GET", pattern: "/api/rooms", auth: true },
  { method: "POST", pattern: "/api/rooms", auth: true },
  { method: "GET", pattern: "/api/rooms/:roomId/messages", auth: true },
];

test("matchPath extracts parameters", () => {
  assert.deepEqual(matchPath("/api/rooms/:roomId/messages", "/api/rooms/abc/messages"), {
    roomId: "abc",
  });
  assert.equal(matchPath("/api/rooms/:roomId/messages", "/api/rooms/abc"), null);
});

test("resolveRoute distinguishes method and path", () => {
  const match = resolveRoute(routes, "GET", "/api/rooms/room-1/messages");
  assert.equal(match.kind, "match");
  if (match.kind === "match") {
    assert.equal(match.params.roomId, "room-1");
  }
  assert.equal(resolveRoute(routes, "DELETE", "/api/rooms").kind, "method_not_allowed");
  assert.equal(resolveRoute(routes, "GET", "/missing").kind, "not_found");
});
