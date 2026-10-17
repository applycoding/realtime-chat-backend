import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { AppError, isUniqueViolation } from "../errors.js";
import type { PublicUser } from "../types.js";

type UserRow = PublicUser & { passwordHash: string };

function mapUser(row: { id: string; username: string; password_hash: string }): UserRow {
  return { id: row.id, username: row.username, passwordHash: row.password_hash };
}

export async function createUser(
  pool: Pool,
  username: string,
  passwordHash: string,
): Promise<PublicUser> {
  try {
    const result = await pool.query<{ id: string; username: string }>(
      `INSERT INTO users (id, username, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username`,
      [randomUUID(), username, passwordHash],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("user insert returned no row");
    }
    return { id: row.id, username: row.username };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "username_taken", "Username is already taken");
    }
    throw err;
  }
}

export async function findUserByUsername(pool: Pool, username: string): Promise<UserRow | null> {
  const result = await pool.query<{ id: string; username: string; password_hash: string }>(
    `SELECT id, username, password_hash FROM users WHERE username = $1`,
    [username],
  );
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

export async function findUserById(pool: Pool, id: string): Promise<PublicUser | null> {
  const result = await pool.query<{ id: string; username: string }>(
    `SELECT id, username FROM users WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}
