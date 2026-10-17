import type { Redis } from "ioredis";
import { rateLimitRedisKey } from "../keys.js";

const INCR_WITH_TTL = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

export function windowId(nowMs: number, windowSeconds: number): number {
  return Math.floor(nowMs / (windowSeconds * 1000));
}

export function decide(count: number, max: number): { allowed: boolean; remaining: number } {
  if (count <= max) {
    return { allowed: true, remaining: max - count };
  }
  return { allowed: false, remaining: 0 };
}

export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  async consume(
    bucket: string,
    max: number,
    windowSeconds: number,
    nowMs = Date.now(),
  ): Promise<{ allowed: boolean; remaining: number }> {
    const key = rateLimitRedisKey(bucket, windowId(nowMs, windowSeconds));
    const raw = await this.redis.eval(INCR_WITH_TTL, 1, key, String(windowSeconds));
    const count = Number(raw);
    if (!Number.isFinite(count)) {
      throw new Error("rate limit counter was not a number");
    }
    return decide(count, max);
  }
}
