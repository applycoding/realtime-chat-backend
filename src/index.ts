import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { createApp } from "./server.js";

const config = loadConfig();
const app = await createApp(config);
await app.listen();
log.info("listening", { port: app.port });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log.info("shutting down", { signal });
  try {
    await app.close();
  } catch (err) {
    log.error("shutdown failed", err);
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
