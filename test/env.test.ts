import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const KEYS = [
  "TARGET_GROUP_IDS",
  "HISTORICAL_FETCH_LIMIT",
  "HOURS_MISMATCH_THRESHOLD",
  "GOOGLE_SPREADSHEET_ID",
  "GOOGLE_SHEET_TAB_NAME",
  "GOOGLE_SERVICE_ACCOUNT_KEY_FILE",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "ENABLE_AI_FALLBACK",
  "LOG_LEVEL",
  "STATE_FILE_PATH",
] as const;

const previous = new Map<string, string | undefined>();

function isolateEnv(values: Record<string, string>): void {
  for (const key of KEYS) {
    if (!previous.has(key)) previous.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previous.clear();
});

describe("env", () => {
  it("applies defaults and splits group ids", () => {
    isolateEnv({
      GOOGLE_SPREADSHEET_ID: "sheet-id",
      TARGET_GROUP_IDS: "one@g.us, two@g.us",
    });
    const config = loadEnv({ requireGroups: true });
    expect(config.targetGroupIds).toEqual(["one@g.us", "two@g.us"]);
    expect(config.historicalFetchLimit).toBe(300);
    expect(config.hoursMismatchThreshold).toBe(0.5);
    expect(config.sheetTabName).toBe("Raw_Logs");
    expect(config.geminiModel).toBe("gemini-3.5-flash-lite");
    expect(config.enableAiFallback).toBe(false);
    expect(config.stateFilePath).toBe("./data/sync_state.json");
  });

  it("requires a spreadsheet id and, for the daemon, at least one group", () => {
    isolateEnv({});
    expect(() => loadEnv({ requireGroups: false })).toThrow(/GOOGLE_SPREADSHEET_ID/);
    isolateEnv({ GOOGLE_SPREADSHEET_ID: "sheet-id" });
    expect(() => loadEnv({ requireGroups: true })).toThrow(/TARGET_GROUP_IDS/);
  });
});
