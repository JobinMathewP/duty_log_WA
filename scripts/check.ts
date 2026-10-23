import fs from "node:fs";
import { loadEnv, type AppConfig } from "../src/config/env.js";
import { pingGemini } from "../src/parser/gemini.js";
import { GoogleSheets } from "../src/services/sheets.js";
import { createLogger } from "../src/utils/logger.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

let config: AppConfig;
try {
  config = loadEnv({ requireGroups: false });
  record("env", true, "parsed");
} catch (error) {
  record("env", false, error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (config.targetGroupIds.length === 0) {
  record("groups", false, "TARGET_GROUP_IDS is empty. Run npm run list-groups and paste the ids.");
} else {
  record("groups", true, config.targetGroupIds.join(", "));
}

try {
  const raw = fs.readFileSync(config.serviceAccountKeyFile, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const key = parsed as { client_email?: unknown; private_key?: unknown };
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    record("credentials", false, "JSON is missing client_email or private_key");
  } else {
    record("credentials", true, `share the spreadsheet with ${key.client_email} as Editor`);
    try {
      const sheets = new GoogleSheets(config, createLogger("error"));
      const title = await sheets.ping();
      record("sheet", true, title);
    } catch (error) {
      record("sheet", false, error instanceof Error ? error.message : String(error));
    }
  }
} catch (error) {
  record("credentials", false, error instanceof Error ? error.message : String(error));
}

if (!config.enableAiFallback) {
  record("gemini", true, "disabled");
} else if (!config.geminiApiKey) {
  record("gemini", false, "ENABLE_AI_FALLBACK is true but GEMINI_API_KEY is empty");
} else {
  try {
    await pingGemini(config.geminiApiKey, config.geminiModel);
    record("gemini", true, config.geminiModel);
  } catch (error) {
    record("gemini", false, error instanceof Error ? error.message : String(error));
  }
}

if (results.some((item) => !item.ok)) process.exitCode = 1;
