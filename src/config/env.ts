import { z } from "zod";
import dotenv from "dotenv";

const boolFromString = z.preprocess(
  (value) => (value === undefined || value === "" ? "false" : value),
  z.enum(["true", "false"]).transform((value) => value === "true"),
);

const positiveInt = z.preprocess(
  (value) => (value === undefined || value === "" ? 300 : value),
  z.coerce.number().int().positive(),
);

const nonNegative = z.preprocess(
  (value) => (value === undefined || value === "" ? 0.5 : value),
  z.coerce.number().nonnegative(),
);

const schema = z.object({
  TARGET_GROUP_IDS: z.string().optional().default(""),
  HISTORICAL_FETCH_LIMIT: positiveInt,
  HOURS_MISMATCH_THRESHOLD: nonNegative,
  GOOGLE_SPREADSHEET_ID: z.string().min(1, "GOOGLE_SPREADSHEET_ID is required"),
  GOOGLE_SHEET_TAB_NAME: z.string().min(1).default("Raw_Logs"),
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().min(1).default("./credentials.json"),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  ENABLE_AI_FALLBACK: boolFromString,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  STATE_FILE_PATH: z.string().min(1).default("./data/sync_state.json"),
});

export interface AppConfig {
  targetGroupIds: string[];
  historicalFetchLimit: number;
  hoursMismatchThreshold: number;
  spreadsheetId: string;
  sheetTabName: string;
  serviceAccountKeyFile: string;
  geminiApiKey: string;
  geminiModel: string;
  enableAiFallback: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  stateFilePath: string;
}

export function loadEnv(options: { requireGroups: boolean }): AppConfig {
  dotenv.config();
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  const targetGroupIds = parsed.data.TARGET_GROUP_IDS.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (options.requireGroups && targetGroupIds.length === 0) {
    throw new Error("Invalid environment: TARGET_GROUP_IDS is required");
  }
  return {
    targetGroupIds,
    historicalFetchLimit: parsed.data.HISTORICAL_FETCH_LIMIT,
    hoursMismatchThreshold: parsed.data.HOURS_MISMATCH_THRESHOLD,
    spreadsheetId: parsed.data.GOOGLE_SPREADSHEET_ID,
    sheetTabName: parsed.data.GOOGLE_SHEET_TAB_NAME,
    serviceAccountKeyFile: parsed.data.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    geminiApiKey: parsed.data.GEMINI_API_KEY,
    geminiModel: parsed.data.GEMINI_MODEL,
    enableAiFallback: parsed.data.ENABLE_AI_FALLBACK,
    logLevel: parsed.data.LOG_LEVEL,
    stateFilePath: parsed.data.STATE_FILE_PATH,
  };
}
