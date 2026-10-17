import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const LOCK_KEY = 87123401;

export async function migrate(pool: Pool): Promise<void> {
  const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
  const sql = await readFile(schemaPath, "utf8");
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [LOCK_KEY]);
    await client.query(sql);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}
