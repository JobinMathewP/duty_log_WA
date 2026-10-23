import { describe, expect, it } from "vitest";
import { rowFromUpdatedRange, withRetry } from "../src/services/sheets.js";

describe("sheets helpers", () => {
  it("reads the appended row from updatedRange", () => {
    expect(rowFromUpdatedRange("Raw_Logs!A14:W14")).toBe(14);
    expect(rowFromUpdatedRange("'Raw Logs'!A3:W3")).toBe(3);
  });

  it("retries 429 and then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("rate") as Error & { code: number };
        error.code = 429;
        throw error;
      }
      return "ok";
    }, [0, 0, 0]);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry a normal client error", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        const error = new Error("bad") as Error & { code: number };
        error.code = 400;
        throw error;
      }, [0, 0, 0]),
    ).rejects.toThrow("bad");
    expect(calls).toBe(1);
  });
});
