import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { ticketKey } from "../keys.js";
import type { PublicUser } from "../types.js";
import { isRecord } from "../validation.js";

const TICKET_TTL_SECONDS = 30;

export async function issueTicket(redis: Redis, user: PublicUser): Promise<string> {
  const ticket = randomUUID();
  await redis.set(ticketKey(ticket), JSON.stringify(user), "EX", TICKET_TTL_SECONDS);
  return ticket;
}

export async function consumeTicket(redis: Redis, ticket: string): Promise<PublicUser | null> {
  if (!/^[0-9a-f-]{36}$/i.test(ticket)) {
    return null;
  }
  const raw = await redis.getdel(ticketKey(ticket));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.username !== "string") {
      return null;
    }
    return { id: parsed.id, username: parsed.username };
  } catch {
    return null;
  }
}
