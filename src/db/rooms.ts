import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AppError, isUniqueViolation } from "../errors.js";
import type { PublicRoom, PublicUser, RoomKind } from "../types.js";
import { withTransaction } from "./tx.js";

type Queryable = Pool | PoolClient;

type RoomRow = {
  id: string;
  name: string | null;
  kind: string;
  created_at: Date;
};

function asKind(value: string): RoomKind {
  if (value === "room" || value === "dm") {
    return value;
  }
  throw new Error(`Unexpected room kind: ${value}`);
}

function mapRoom(row: RoomRow): PublicRoom {
  return {
    id: row.id,
    name: row.name,
    kind: asKind(row.kind),
    createdAt: row.created_at.toISOString(),
  };
}

export function orderUserPair(left: string, right: string): [string, string] {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) {
    throw new AppError(400, "invalid_dm", "You cannot direct-message yourself");
  }
  return a < b ? [a, b] : [b, a];
}

async function loadRoom(db: Queryable, roomId: string): Promise<PublicRoom> {
  const result = await db.query<RoomRow>(
    `SELECT id, name, kind, created_at FROM rooms WHERE id = $1`,
    [roomId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(404, "not_found", "Room not found");
  }
  return mapRoom(row);
}

async function ensureMember(db: Queryable, roomId: string, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [roomId, userId],
  );
}

export async function createRoom(pool: Pool, name: string, createdBy: string): Promise<PublicRoom> {
  return withTransaction(pool, async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO rooms (id, name, kind, created_by) VALUES ($1, $2, 'room', $3)`,
      [id, name, createdBy],
    );
    await ensureMember(client, id, createdBy);
    return loadRoom(client, id);
  });
}

export async function joinRoom(pool: Pool, roomId: string, userId: string): Promise<PublicRoom> {
  const room = await loadRoom(pool, roomId);
  if (room.kind !== "room") {
    throw new AppError(403, "forbidden", "Direct messages cannot be joined by id");
  }
  await ensureMember(pool, roomId, userId);
  return room;
}

export async function leaveRoom(pool: Pool, roomId: string, userId: string): Promise<void> {
  const room = await pool.query(`SELECT id FROM rooms WHERE id = $1`, [roomId]);
  if (!room.rows[0]) {
    throw new AppError(404, "not_found", "Room not found");
  }
  await pool.query(`DELETE FROM room_members WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);
}

export async function requireRoomMember(pool: Pool, roomId: string, userId: string): Promise<void> {
  const room = await pool.query(`SELECT id FROM rooms WHERE id = $1`, [roomId]);
  if (!room.rows[0]) {
    throw new AppError(404, "not_found", "Room not found");
  }
  const member = await pool.query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId],
  );
  if (!member.rows[0]) {
    throw new AppError(403, "forbidden", "Not a member of this room");
  }
}

export async function listRoomsForUser(pool: Pool, userId: string): Promise<PublicRoom[]> {
  const result = await pool.query<RoomRow>(
    `SELECT r.id,
            CASE
              WHEN r.kind = 'dm' THEN (
                SELECT u.username
                FROM room_members om
                JOIN users u ON u.id = om.user_id
                WHERE om.room_id = r.id AND om.user_id <> $1
                LIMIT 1
              )
              ELSE r.name
            END AS name,
            r.kind,
            r.created_at
     FROM rooms r
     JOIN room_members me ON me.room_id = r.id AND me.user_id = $1
     ORDER BY r.created_at DESC`,
    [userId],
  );
  return result.rows.map(mapRoom);
}

export async function listRoomIdsForUser(pool: Pool, userId: string): Promise<string[]> {
  const result = await pool.query<{ room_id: string }>(
    `SELECT room_id FROM room_members WHERE user_id = $1`,
    [userId],
  );
  return result.rows.map((row) => row.room_id);
}

export async function listMembers(pool: Pool, roomId: string): Promise<PublicUser[]> {
  const result = await pool.query<PublicUser>(
    `SELECT u.id, u.username
     FROM room_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.room_id = $1
     ORDER BY u.username`,
    [roomId],
  );
  return result.rows;
}

async function findDm(pool: Pool, low: string, high: string): Promise<PublicRoom | null> {
  const result = await pool.query<{ room_id: string }>(
    `SELECT room_id FROM dm_pairs WHERE user_low = $1 AND user_high = $2`,
    [low, high],
  );
  const roomId = result.rows[0]?.room_id;
  if (!roomId) {
    return null;
  }
  await ensureMember(pool, roomId, low);
  await ensureMember(pool, roomId, high);
  return loadRoom(pool, roomId);
}

export async function getOrCreateDm(
  pool: Pool,
  userId: string,
  otherUserId: string,
): Promise<PublicRoom> {
  const [low, high] = orderUserPair(userId, otherUserId);
  try {
    return await withTransaction(pool, async (client) => {
      const existing = await client.query<{ room_id: string }>(
        `SELECT room_id FROM dm_pairs WHERE user_low = $1 AND user_high = $2`,
        [low, high],
      );
      const existingId = existing.rows[0]?.room_id;
      if (existingId) {
        await ensureMember(client, existingId, low);
        await ensureMember(client, existingId, high);
        return loadRoom(client, existingId);
      }
      const created = randomUUID();
      await client.query(
        `INSERT INTO rooms (id, name, kind, created_by) VALUES ($1, NULL, 'dm', $2)`,
        [created, userId],
      );
      await ensureMember(client, created, userId);
      await ensureMember(client, created, otherUserId);
      await client.query(
        `INSERT INTO dm_pairs (user_low, user_high, room_id) VALUES ($1, $2, $3)`,
        [low, high, created],
      );
      return loadRoom(client, created);
    });
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    const room = await findDm(pool, low, high);
    if (!room) {
      throw err;
    }
    return room;
  }
}
