# realtime-chat-backend

Real-time chat backend by Arpan Bom: a WebSocket gateway that fans out through Redis, stores messages in Postgres, and can run as more than one process.

[![CI](https://github.com/applycoding/realtime-chat-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/applycoding/realtime-chat-backend/actions/workflows/ci.yml)

## Honest demo note

This is a portfolio demonstration of the architecture, not a production chat service.

- One shared HMAC secret signs JWTs. There is no refresh-token rotation, SSO, or key rotation.
- The browser asks for a 30-second single-use ticket, then connects. The long-lived token stays on `Authorization` headers.
- Rooms are open: any authenticated user who knows the id can join. There are no roles, blocks, or moderation tools.
- Direct messages are just two-member rooms. There is no encryption, edit, delete, attachments, or push.
- Presence is best-effort. Each socket refreshes a Redis key with a TTL. A crashed process stops refreshing; other clients learn that on the next presence read, not from a membership consensus protocol. A graceful close publishes offline immediately.
- Typing indicators are ephemeral and are not stored.
- The rate limiter is a fixed window counter in Redis.
- Schema SQL runs on boot (`CREATE TABLE IF NOT EXISTS`). There is no versioned migration history.
- Auth rate limits use the TCP peer address. `X-Forwarded-For` is ignored.
- The page in `public/` is a minimal client for clicking through the API. It is not a product UI.
- Nothing here is a benchmark. This repo does not claim a throughput, latency, or connection count.

## Architecture

Any number of gateway processes share one Postgres and one Redis. A client can reconnect to a different process. Missed messages are loaded from Postgres with the last cursor; sticky sessions are not required.

```mermaid
flowchart TB
  subgraph clients [Clients]
    Web[Demo page]
  end

  subgraph gateways [Gateway processes]
    G1[Gateway A]
    G2[Gateway B]
  end

  Web -->|HTTP JSON and WebSocket| G1
  Web -->|HTTP JSON and WebSocket| G2
  G1 <-->|room and presence channels| Redis[(Redis)]
  G2 <-->|room and presence channels| Redis
  G1 -->|messages, rooms, receipts| PG[(Postgres)]
  G2 -->|messages, rooms, receipts| PG
```

A send is one insert, then one publish. Every process that has a local subscriber for that room, including the sender's process, writes the event to its sockets. Retries with the same `clientMsgId` return the original row and do not publish again.

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Gateway
  participant P as Postgres
  participant R as Redis
  participant O as Other gateways
  C->>G: message frame
  G->>G: membership and rate limit
  G->>P: insert message
  G->>R: publish room channel
  R-->>G: deliver to local sockets
  R-->>O: deliver to local sockets
```

History is cursor pagination on the message id, which is a `BIGSERIAL`. The HTTP cursor is an opaque base64url payload `{ "v": 1, "id": "<message id>" }`. `GET /api/rooms/:id/messages?before=<cursor>&limit=<n>` returns a page in chronological order and a `nextCursor` for the next older page. Reconnect sends `resume` with that same cursor style; the gateway replies with messages strictly after that id.

## Run

```bash
docker compose up --build
```

Open `http://localhost:3000`. Register two users in two browsers. Create a room in one, join it by id in the other.

The compose file sets `JWT_SECRET=dev-only-change-me-please`. Change that before the process is reachable by anyone else. Postgres data lives in the `pgdata` volume. Redis is empty on each container start. `docker compose down -v` drops the database volume.

A second gateway on the host, against the same compose Postgres and Redis:

```bash
docker compose up -d postgres redis
export DATABASE_URL=postgres://chat:chat@127.0.0.1:5432/chat
export REDIS_URL=redis://127.0.0.1:6379
export JWT_SECRET=dev-only-change-me-please
npm ci
PORT=3000 npm run dev
PORT=3001 npm run dev
```

Point one browser at port 3000 and another at 3001. Integration coverage for this path is `two gateway processes fan out a room message` in CI. It checks delivery, not capacity.

## HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/register` | `{ username, password }` → `{ token, user }` |
| POST | `/api/login` | Same body. Unknown user and wrong password share one error. |
| POST | `/api/ws-ticket` | Bearer token → `{ ticket }` |
| GET | `/api/me` | Current user |
| POST | `/api/rooms` | `{ name }` creates a public room and joins the caller |
| GET | `/api/rooms` | Rooms the caller belongs to |
| POST | `/api/rooms/:id/join` | Join a public room |
| POST | `/api/rooms/:id/leave` | Leave |
| GET | `/api/rooms/:id/messages?before&limit` | Older history page |
| GET | `/api/rooms/:id/receipts` | Latest read pointer per member |
| POST | `/api/dm` | `{ username }` opens or reuses a DM |
| GET | `/health` | Postgres and Redis probes |

Passwords are stored as scrypt hashes with pinned parameters. Usernames are 3–32 characters from `[A-Za-z0-9_]` and are stored lowercase.

## WebSocket

Connect to `/ws?ticket=<ticket>`. Frames are JSON.

Client: `join`, `leave`, `message` (`roomId`, `body`, `clientMsgId`), `typing`, `read`, `resume` (`roomId`, `after` cursor).

Server: `ready`, `joined` (with `onlineUsers`), `left`, `message`, `typing`, `read`, `presence`, `replay`, `error`.

`message` requires the socket to have joined that room, and the user to still be a member. Message ids are decimal strings so they do not pass through JavaScript numbers.

## Tests

Unit tests cover JWT verification, password checks, cursor encode/decode, frame parsing, the rate-limit window, routing, and the room-join lock. They do not need Postgres or Redis.

Integration tests boot the server against Postgres and Redis. GitHub Actions starts those as service containers; see `.github/workflows/ci.yml`. The job checks health, auth, cursor history, reconnect replay, typing, read receipts, idempotent sends, direct messages, presence, cross-process fan-out, and the message rate limit.

```bash
npm run typecheck
npm run test:unit
npm run test:integration   # needs DATABASE_URL, REDIS_URL, and JWT_SECRET
```

## Configuration

See `.env.example`. `DATABASE_URL`, `REDIS_URL`, and `JWT_SECRET` (at least 16 characters) are required. Limits and TTLs have defaults in `src/config.ts`.

## Layout

```
src/auth        JWT, scrypt passwords, single-use socket tickets
src/chat        cursors, Redis rate limit, presence, pub/sub bus
src/db          bootstrap SQL and queries
src/http        router and JSON API
src/ws          frame parser and gateway
public          one-page demo client
test/unit
test/integration
```
