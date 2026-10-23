import { loadEnv } from "../src/config/env.js";
import { GoogleSheets } from "../src/services/sheets.js";
import { createLogger } from "../src/utils/logger.js";

const config = loadEnv({ requireGroups: false });
const logger = createLogger(config.logLevel);
const sheets = new GoogleSheets(config, logger);

try {
  await sheets.ensureTabAndHeader();
  await sheets.ensureExistingMonthViews();
  const title = await sheets.ping();
  console.log(`[info] ${config.sheetTabName} is ready in "${title}"`);
} catch (error) {
  console.error(`[error] setup failed ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
