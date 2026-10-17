import type { Pool } from "pg";
import { decodeCursor, encodeCursor, takePage } from "../chat/cursor.js";
import type { PublicMessage } from "../types.js";

type MessageRow = {
  id: string;
  room_id: string;
  sender_id: string;
  username: string;
  body: string;
  client_msg_id: string | null;
  created_at: Date;
};

const MESSAGE_SELECT = `
  SELECT m.id::text AS id,
         m.room_id,
         m.sender_id,
         u.username,
         m.body,
         m.client_msg_id,
         m.created_at
  FROM messages m
  JOIN users u ON u.id = m.sender_id
`;

function toPublic(row: MessageRow): PublicMessage {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    username: row.username,
    body: row.body,
    clientMsgId: row.client_msg_id,
    createdAt: row.created_at.toISOString(),
  };
}

export async function findByClientMsgId(
  pool: Pool,
  roomId: string,
  senderId: string,
  clientMsgId: string,
): Promise<PublicMessage | null> {
  const result = await pool.query<MessageRow>(
    `${MESSAGE_SELECT}
     WHERE m.room_id = $1 AND m.sender_id = $2 AND m.client_msg_id = $3`,
    [roomId, senderId, clientMsgId],
  );
  const row = result.rows[0];
  return row ? toPublic(row) : null;
}

export async function insertMessage(
  pool: Pool,
  input: {
    roomId: string;
    senderId: string;
    username: string;
    body: string;
    clientMsgId: string;
  },
): Promise<{ message: PublicMessage; duplicate: boolean }> {
  const inserted = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO messages (room_id, sender_id, body, client_msg_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (room_id, sender_id, client_msg_id) WHERE client_msg_id IS NOT NULL
     DO NOTHING
     RETURNING id::text AS id, created_at`,
    [input.roomId, input.senderId, input.body, input.clientMsgId],
  );
  const row = inserted.rows[0];
  if (!row) {
    const existing = await findByClientMsgId(pool, input.roomId, input.senderId, input.clientMsgId);
    if (!existing) {
      throw new Error("message conflict but row missing");
    }
    return { message: existing, duplicate: true };
  }
  return {
    duplicate: false,
    message: {
      id: row.id,
      roomId: input.roomId,
      senderId: input.senderId,
      username: input.username,
      body: input.body,
      clientMsgId: input.clientMsgId,
      createdAt: row.created_at.toISOString(),
    },
  };
}

export async function listMessagesBefore(
  pool: Pool,
  roomId: string,
  beforeCursor: string | null,
  limit: number,
): Promise<{ messages: PublicMessage[]; nextCursor: string | null }> {
  const beforeId = beforeCursor ? decodeCursor(beforeCursor) : null;
  const result = await pool.query<MessageRow>(
    `${MESSAGE_SELECT}
     WHERE m.room_id = $1
       AND ($2::bigint IS NULL OR m.id < $2::bigint)
     ORDER BY m.id DESC
     LIMIT $3`,
    [roomId, beforeId, limit + 1],
  );
  const page = takePage(result.rows, limit);
  const oldest = page.rows[page.rows.length - 1];
  return {
    messages: page.rows.slice().reverse().map(toPublic),
    nextCursor: page.hasMore && oldest ? encodeCursor(oldest.id) : null,
  };
}

export async function listMessagesAfter(
  pool: Pool,
  roomId: string,
  afterCursor: string,
  limit: number,
): Promise<{ messages: PublicMessage[]; hasMore: boolean }> {
  const afterId = decodeCursor(afterCursor);
  const result = await pool.query<MessageRow>(
    `${MESSAGE_SELECT}
     WHERE m.room_id = $1 AND m.id > $2::bigint
     ORDER BY m.id ASC
     LIMIT $3`,
    [roomId, afterId, limit + 1],
  );
  const page = takePage(result.rows, limit);
  return { messages: page.rows.map(toPublic), hasMore: page.hasMore };
}
