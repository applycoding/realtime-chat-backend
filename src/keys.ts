export function roomChannel(roomId: string): string {
  return `chat:room:${roomId}`;
}

export function presenceChannel(): string {
  return "chat:presence";
}

export function presenceConnsKey(userId: string): string {
  return `chat:presence:conns:${userId}`;
}

export function presenceConnKey(connId: string): string {
  return `chat:presence:conn:${connId}`;
}

export const presenceConnPrefix = "chat:presence:conn:";

export function rateLimitRedisKey(bucket: string, window: number): string {
  return `chat:rl:${bucket}:${window}`;
}

export function ticketKey(ticket: string): string {
  return `chat:ws:ticket:${ticket}`;
}
