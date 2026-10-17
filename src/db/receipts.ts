import type { Pool } from "pg";
import type { ReadReceipt } from "../types.js";

export type MarkReadResult =
  | { status: "advanced"; messageId: string; readAt: string }
  | { status: "stale" }
  | { status: "missing" };

export async function markRead(
  pool: Pool,
  roomId: string,
  userId: string,
  messageId: string,
): Promise<MarkReadResult> {
  const updated = await pool.query<{ message_id: string; read_at: Date }>(
    `INSERT INTO read_receipts (room_id, user_id, message_id, read_at)
     SELECT $1, $2, m.id, now()
     FROM messages m
     WHERE m.id = $3::bigint AND m.room_id = $1
     ON CONFLICT (room_id, user_id)
     DO UPDATE SET message_id = EXCLUDED.message_id, read_at = now()
     WHERE read_receipts.message_id < EXCLUDED.message_id
     RETURNING message_id::text AS message_id, read_at`,
    [roomId, userId, messageId],
  );
  const row = updated.rows[0];
  if (row) {
    return { status: "advanced", messageId: row.message_id, readAt: row.read_at.toISOString() };
  }
  const existing = await pool.query(
    `SELECT id FROM messages WHERE id = $1::bigint AND room_id = $2`,
    [messageId, roomId],
  );
  if (!existing.rows[0]) {
    return { status: "missing" };
  }
  return { status: "stale" };
}

export async function listReceipts(pool: Pool, roomId: string): Promise<ReadReceipt[]> {
  const result = await pool.query<{
    user_id: string;
    username: string;
    message_id: string;
    read_at: Date;
  }>(
    `SELECT rr.user_id, u.username, rr.message_id::text AS message_id, rr.read_at
     FROM read_receipts rr
     JOIN users u ON u.id = rr.user_id
     WHERE rr.room_id = $1
     ORDER BY u.username`,
    [roomId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    username: row.username,
    messageId: row.message_id,
    readAt: row.read_at.toISOString(),
  }));
}
