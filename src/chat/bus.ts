import type { Redis } from "ioredis";
import { log } from "../logger.js";
import { presenceChannel, roomChannel } from "../keys.js";
import type { PublicMessage } from "../types.js";
import { isRecord } from "../validation.js";

export type RoomBusEvent =
  | { type: "message"; message: PublicMessage }
  | { type: "typing"; roomId: string; userId: string; username: string; isTyping: boolean }
  | { type: "read"; roomId: string; userId: string; messageId: string; readAt: string };

export type PresenceBusEvent = {
  type: "presence";
  userId: string;
  username: string;
  status: "online" | "offline";
};

type Handlers = {
  onRoom: (roomId: string, event: RoomBusEvent) => void;
  onPresence: (event: PresenceBusEvent) => void;
};

function isMessage(value: unknown): value is PublicMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.roomId === "string" &&
    typeof value.senderId === "string" &&
    typeof value.username === "string" &&
    typeof value.body === "string" &&
    (value.clientMsgId === null || typeof value.clientMsgId === "string") &&
    typeof value.createdAt === "string"
  );
}

function parseRoomEvent(value: unknown): RoomBusEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.type === "message" && isMessage(value.message)) {
    return { type: "message", message: value.message };
  }
  if (
    value.type === "typing" &&
    typeof value.roomId === "string" &&
    typeof value.userId === "string" &&
    typeof value.username === "string" &&
    typeof value.isTyping === "boolean"
  ) {
    return {
      type: "typing",
      roomId: value.roomId,
      userId: value.userId,
      username: value.username,
      isTyping: value.isTyping,
    };
  }
  if (
    value.type === "read" &&
    typeof value.roomId === "string" &&
    typeof value.userId === "string" &&
    typeof value.messageId === "string" &&
    typeof value.readAt === "string"
  ) {
    return {
      type: "read",
      roomId: value.roomId,
      userId: value.userId,
      messageId: value.messageId,
      readAt: value.readAt,
    };
  }
  return null;
}

function parsePresence(value: unknown): PresenceBusEvent | null {
  if (
    !isRecord(value) ||
    value.type !== "presence" ||
    typeof value.userId !== "string" ||
    typeof value.username !== "string" ||
    (value.status !== "online" && value.status !== "offline")
  ) {
    return null;
  }
  return {
    type: "presence",
    userId: value.userId,
    username: value.username,
    status: value.status,
  };
}

export class EventBus {
  private handlers: Handlers | null = null;
  private readonly rooms = new Set<string>();
  private started = false;

  constructor(private readonly subscriber: Redis, private readonly publisher: Redis) {}

  setHandlers(handlers: Handlers): void {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.subscriber.on("message", (channel: string, payload: string) => {
      this.onMessage(channel, payload);
    });
    await this.subscriber.subscribe(presenceChannel());
    this.started = true;
  }

  async subscribeRoom(roomId: string): Promise<void> {
    if (this.rooms.has(roomId)) {
      return;
    }
    await this.subscriber.subscribe(roomChannel(roomId));
    this.rooms.add(roomId);
  }

  async unsubscribeRoom(roomId: string): Promise<void> {
    if (!this.rooms.has(roomId)) {
      return;
    }
    this.rooms.delete(roomId);
    await this.subscriber.unsubscribe(roomChannel(roomId));
  }

  async publishRoom(roomId: string, event: RoomBusEvent): Promise<void> {
    await this.publisher.publish(roomChannel(roomId), JSON.stringify(event));
  }

  async publishPresence(event: PresenceBusEvent): Promise<void> {
    await this.publisher.publish(presenceChannel(), JSON.stringify(event));
  }

  async close(): Promise<void> {
    this.subscriber.removeAllListeners("message");
    if (this.rooms.size > 0 || this.started) {
      await this.subscriber.unsubscribe();
    }
    this.rooms.clear();
    this.started = false;
  }

  private onMessage(channel: string, payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch (err) {
      log.error("dropped bus payload", err, { channel });
      return;
    }
    if (channel === presenceChannel()) {
      const event = parsePresence(parsed);
      if (!event) {
        log.error("dropped presence payload", undefined, { channel });
        return;
      }
      this.handlers?.onPresence(event);
      return;
    }
    const prefix = "chat:room:";
    if (!channel.startsWith(prefix)) {
      return;
    }
    const event = parseRoomEvent(parsed);
    if (!event) {
      log.error("dropped room payload", undefined, { channel });
      return;
    }
    this.handlers?.onRoom(channel.slice(prefix.length), event);
  }
}
