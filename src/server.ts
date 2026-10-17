import type { Server } from "node:http";
import { Redis } from "ioredis";
import pg from "pg";
import { EventBus } from "./chat/bus.js";
import { PresenceStore } from "./chat/presence.js";
import { RateLimiter } from "./chat/ratelimit.js";
import type { Config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createHttpServer, loadClientHtml } from "./http/api.js";
import { log } from "./logger.js";
import { Gateway } from "./ws/gateway.js";

export type App = {
  port: number;
  listen: (port?: number) => Promise<void>;
  close: () => Promise<void>;
};

function redisClient(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    connectTimeout: 10_000,
  });
}

async function closeHttp(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function release(resources: {
  bus?: EventBus;
  subscriber: Redis;
  redis: Redis;
  pool: pg.Pool;
}): Promise<void> {
  await resources.bus?.close().catch(() => undefined);
  await resources.subscriber.quit().catch(() => undefined);
  await resources.redis.quit().catch(() => undefined);
  await resources.pool.end().catch(() => undefined);
}

export async function createApp(config: Config): Promise<App> {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 10_000,
    max: 10,
  });
  pool.on("error", (err) => {
    log.error("pg pool error", err);
  });
  const redis = redisClient(config.redisUrl);
  const subscriber = redisClient(config.redisUrl);
  redis.on("error", (err) => {
    log.error("redis error", err);
  });
  subscriber.on("error", (err) => {
    log.error("redis subscriber error", err);
  });

  const bus = new EventBus(subscriber, redis);
  try {
    await redis.connect();
    await subscriber.connect();
    await migrate(pool);
    const presence = new PresenceStore(redis, config.presenceTtlSeconds);
    const limiter = new RateLimiter(redis);
    const gateway = new Gateway({ pool, redis, bus, presence, limiter, config });
    bus.setHandlers({
      onRoom: (roomId, event) => {
        gateway.handleRoomEvent(roomId, event);
      },
      onPresence: (event) => {
        void gateway.handlePresence(event);
      },
    });
    await bus.start();
    const html = await loadClientHtml(config.staticDir);
    const httpServer = createHttpServer({ config, pool, redis, limiter }, html);
    gateway.attach(httpServer);

    let port = config.port;
    let closed = false;
    return {
      get port() {
        return port;
      },
      async listen(listenPort = config.port): Promise<void> {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            reject(err);
          };
          httpServer.once("error", onError);
          httpServer.listen(listenPort, "0.0.0.0", () => {
            httpServer.off("error", onError);
            const address = httpServer.address();
            if (!address || typeof address === "string") {
              reject(new Error("Expected a TCP address"));
              return;
            }
            port = address.port;
            resolve();
          });
        });
      },
      async close(): Promise<void> {
        if (closed) {
          return;
        }
        closed = true;
        await gateway.shutdown();
        await closeHttp(httpServer);
        await bus.close();
        await subscriber.quit();
        await redis.quit();
        await pool.end();
      },
    };
  } catch (err) {
    await release({ bus, subscriber, redis, pool });
    throw err;
  }
}
