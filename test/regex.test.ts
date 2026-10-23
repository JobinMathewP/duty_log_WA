import { describe, expect, it, vi } from "vitest";

vi.mock("../src/parser/gemini.js", () => ({
  askGemini: vi.fn(() => {
    throw new Error("gemini should not run for a clean log");
  }),
}));

import { parseMessage } from "../src/parser/index.js";
import { extractFields } from "../src/parser/regex.js";
import { CANONICAL_LOG } from "./sample.js";

const options = {
  hoursMismatchThreshold: 0.5,
  enableAiFallback: true,
  geminiApiKey: "test-key",
  geminiModel: "gemini-3.5-flash-lite",
};

describe("regex tier", () => {
  it("parses the canonical field log", async () => {
    const record = await parseMessage(CANONICAL_LOG, options);
    expect(record).toMatchObject({
      status: "ACTIVE",
      parser: "REGEX",
      logName: "Nagarajan",
      weekday: "Tuesday",
      site: "Al barsha NS147",
      dutyDate: "2026-10-20",
      start: "06:53",
      pause: "13:43",
      resume: "14:38",
      finish: "17:04",
      reportedHours: 9,
      calculatedHours: 9.27,
      countableHours: 9,
      technicians: "Sibirajan, Vicky, Arjun",
      associates: "Sathish, Nitiesh",
      notes: [],
    });
  });

  it("does not treat the associate line as the technician line", () => {
    const fields = extractFields(
      "Associate technician: Sathish , Nitiesh\nTechnician: Sibirajan,Vicky, Arjun",
    );
    expect(fields.associates).toBe("Sathish , Nitiesh");
    expect(fields.technicians).toBe("Sibirajan,Vicky, Arjun");
  });

  it("stores an incomplete candidate as needs review and keeps a written total", async () => {
    const record = await parseMessage(
      "Site: Al barsha NS147\nStart duty: 6.53\nTotal working hrs: 8 Hrs\nTechnician: Arjun",
      { ...options, enableAiFallback: false, geminiApiKey: "" },
    );
    expect(record?.status).toBe("NEEDS_REVIEW");
    expect(record?.countableHours).toBe(8);
    expect(record?.finish).toBe("");
  });
});
