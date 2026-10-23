import { loadEnv } from "./config/env.js";
import { attachQr, createClient, type WaClient } from "./core/client.js";
import { runCatchup } from "./core/catchup.js";
import { attachEvents } from "./core/events.js";
import { GoogleSheets } from "./services/sheets.js";
import { StateStore } from "./services/state.js";
import { createLogger } from "./utils/logger.js";

const config = loadEnv({ requireGroups: true });
const logger = createLogger(config.logLevel);
const sheets = new GoogleSheets(config, logger);
const state = new StateStore(config.stateFilePath, logger);
let client: WaClient | undefined;
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("shutdown", { signal });
  await state.persist().catch(() => undefined);
  await client?.destroy().catch(() => undefined);
  process.exit(0);
}

async function main(): Promise<void> {
  const loaded = await state.tryLoad();
  if (!loaded) {
    logger.warn("state missing or unreadable, rebuilding from the sheet");
    state.replace(await sheets.rebuildState());
    await state.persist();
  }
  await sheets.ensureExistingMonthViews();

  client = createClient();
  const deps = { config, logger, state, sheets };
  attachQr(client);
  attachEvents(client, deps);
  client.on("ready", () => {
    logger.info("whatsapp ready");
    void runCatchup(client as WaClient, deps);
  });
  client.on("disconnected", (reason) => {
    logger.warn("disconnected", { reason });
  });
  client.on("auth_failure", (message) => {
    logger.error("auth_failure", { message });
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await client.initialize();
}

main().catch((error: unknown) => {
  logger.error("startup failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
