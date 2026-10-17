import type { Redis } from "ioredis";
import { presenceConnKey, presenceConnPrefix, presenceConnsKey } from "../keys.js";
import type { PublicUser } from "../types.js";

const ACQUIRE = `
local connsKey = KEYS[1]
local connKey = KEYS[2]
local connId = ARGV[1]
local ttl = tonumber(ARGV[2])
local prefix = ARGV[3]
redis.call('SADD', connsKey, connId)
redis.call('SET', connKey, '1', 'EX', ttl)
local members = redis.call('SMEMBERS', connsKey)
local live = 0
for i = 1, #members do
  local key = prefix .. members[i]
  if redis.call('EXISTS', key) == 1 then
    live = live + 1
  else
    redis.call('SREM', connsKey, members[i])
  end
end
return live
`;

const RELEASE = `
local connsKey = KEYS[1]
local connKey = KEYS[2]
local connId = ARGV[1]
local prefix = ARGV[2]
redis.call('SREM', connsKey, connId)
redis.call('DEL', connKey)
local members = redis.call('SMEMBERS', connsKey)
local live = 0
for i = 1, #members do
  local key = prefix .. members[i]
  if redis.call('EXISTS', key) == 1 then
    live = live + 1
  else
    redis.call('SREM', connsKey, members[i])
  end
end
return live
`;

export class PresenceStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async acquire(userId: string, connId: string): Promise<"online" | "unchanged"> {
    const live = await this.evalCount(ACQUIRE, userId, connId, [
      connId,
      String(this.ttlSeconds),
      presenceConnPrefix,
    ]);
    return live === 1 ? "online" : "unchanged";
  }

  async release(userId: string, connId: string): Promise<"offline" | "unchanged"> {
    const live = await this.evalCount(RELEASE, userId, connId, [connId, presenceConnPrefix]);
    return live === 0 ? "offline" : "unchanged";
  }

  async refresh(userId: string, connId: string): Promise<"online" | "unchanged"> {
    const updated = await this.redis.set(presenceConnKey(connId), "1", "EX", this.ttlSeconds, "XX");
    if (updated === null) {
      return this.acquire(userId, connId);
    }
    return "unchanged";
  }

  async onlineUsers(members: readonly PublicUser[]): Promise<PublicUser[]> {
    if (members.length === 0) {
      return [];
    }
    const pipeline = this.redis.pipeline();
    for (const member of members) {
      pipeline.smembers(presenceConnsKey(member.id));
    }
    const memberSets = await pipeline.exec();
    const connIds: string[][] = members.map((_, index) => {
      const entry = memberSets?.[index];
      const value = entry?.[1];
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    });
    const existsPipe = this.redis.pipeline();
    const flat: Array<{ memberIndex: number; connId: string }> = [];
    connIds.forEach((ids, memberIndex) => {
      for (const connId of ids) {
        flat.push({ memberIndex, connId });
        existsPipe.exists(presenceConnKey(connId));
      }
    });
    const existsResults = flat.length > 0 ? await existsPipe.exec() : [];
    const liveCounts = new Map<number, number>();
    const stale: Array<{ userId: string; connId: string }> = [];
    flat.forEach((item, index) => {
      const exists = existsResults?.[index]?.[1] === 1;
      if (exists) {
        liveCounts.set(item.memberIndex, (liveCounts.get(item.memberIndex) ?? 0) + 1);
      } else {
        const member = members[item.memberIndex];
        if (member) {
          stale.push({ userId: member.id, connId: item.connId });
        }
      }
    });
    if (stale.length > 0) {
      const cleanup = this.redis.pipeline();
      for (const item of stale) {
        cleanup.srem(presenceConnsKey(item.userId), item.connId);
      }
      await cleanup.exec();
    }
    return members.filter((_, index) => (liveCounts.get(index) ?? 0) > 0);
  }

  private async evalCount(
    script: string,
    userId: string,
    connId: string,
    args: string[],
  ): Promise<number> {
    const raw = await this.redis.eval(script, 2, presenceConnsKey(userId), presenceConnKey(connId), ...args);
    const live = Number(raw);
    if (!Number.isFinite(live)) {
      throw new Error("presence script returned a non-numeric count");
    }
    return live;
  }
}
