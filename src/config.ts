export type Config = {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  messageMaxLength: number;
  historyDefaultLimit: number;
  historyMaxLimit: number;
  replayLimit: number;
  messageRateLimitMax: number;
  messageRateLimitWindowSeconds: number;
  typingRateLimitMax: number;
  typingRateLimitWindowSeconds: number;
  authRateLimitMax: number;
  authRateLimitWindowSeconds: number;
  presenceTtlSeconds: number;
  wsHeartbeatMs: number;
  staticDir: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = required(env, "JWT_SECRET");
  if (jwtSecret.length < 16) {
    throw new Error("JWT_SECRET must be at least 16 characters");
  }
  const historyDefaultLimit = intEnv(env, "HISTORY_DEFAULT_LIMIT", 50);
  const historyMaxLimit = intEnv(env, "HISTORY_MAX_LIMIT", 100);
  if (historyDefaultLimit > historyMaxLimit) {
    throw new Error("HISTORY_DEFAULT_LIMIT cannot exceed HISTORY_MAX_LIMIT");
  }
  return {
    port: intEnv(env, "PORT", 3000),
    databaseUrl: required(env, "DATABASE_URL"),
    redisUrl: required(env, "REDIS_URL"),
    jwtSecret,
    jwtTtlSeconds: intEnv(env, "JWT_TTL_SECONDS", 60 * 60 * 24 * 7),
    messageMaxLength: intEnv(env, "MESSAGE_MAX_LENGTH", 4000),
    historyDefaultLimit,
    historyMaxLimit,
    replayLimit: intEnv(env, "REPLAY_LIMIT", 100),
    messageRateLimitMax: intEnv(env, "MESSAGE_RATE_LIMIT_MAX", 30),
    messageRateLimitWindowSeconds: intEnv(env, "MESSAGE_RATE_LIMIT_WINDOW_SECONDS", 10),
    typingRateLimitMax: intEnv(env, "TYPING_RATE_LIMIT_MAX", 20),
    typingRateLimitWindowSeconds: intEnv(env, "TYPING_RATE_LIMIT_WINDOW_SECONDS", 10),
    authRateLimitMax: intEnv(env, "AUTH_RATE_LIMIT_MAX", 20),
    authRateLimitWindowSeconds: intEnv(env, "AUTH_RATE_LIMIT_WINDOW_SECONDS", 60),
    presenceTtlSeconds: intEnv(env, "PRESENCE_TTL_SECONDS", 60),
    wsHeartbeatMs: intEnv(env, "WS_HEARTBEAT_MS", 20_000),
    staticDir: env.STATIC_DIR || "public",
  };
}
