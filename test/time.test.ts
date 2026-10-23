import { describe, expect, it } from "vitest";
import { parseClockToken, parseDutyDate, resolveShift } from "../src/parser/time.js";

describe("clock resolver", () => {
  it("keeps a bare morning start at 06:53", () => {
    const shift = resolveShift({ start: "6.53" });
    expect(shift.start).toBe("06:53");
    expect(shift.ambiguous).toBe(false);
  });

  it("reads 5.04 after 14:38 as 17:04 and calculates 9.27 hours", () => {
    const shift = resolveShift({
      start: "6.53",
      pause: "1.43pm",
      resume: "2.38pm",
      finish: "5.04",
    });
    expect(shift).toMatchObject({
      start: "06:53",
      pause: "13:43",
      resume: "14:38",
      finish: "17:04",
      calculatedHours: 9.27,
      ambiguous: false,
      incompleteBreak: false,
    });
  });

  it("converts explicit 12am and 12pm", () => {
    expect(resolveShift({ start: "12:00am" }).start).toBe("00:00");
    expect(resolveShift({ start: "12:00pm" }).start).toBe("12:00");
  });

  it("rejects minute 60", () => {
    expect(parseClockToken("6.60")).toBeNull();
    const shift = resolveShift({ start: "6.60", finish: "5.04pm" });
    expect(shift.start).toBe("");
    expect(shift.ambiguous).toBe(true);
    expect(shift.calculatedHours).toBeNull();
  });

  it("flags a start that is neither morning nor explicit", () => {
    const shift = resolveShift({ start: "4.00", finish: "6.00pm" });
    expect(shift.start).toBe("");
    expect(shift.ambiguous).toBe(true);
  });

  it("parses day.month.year and rejects impossible dates", () => {
    expect(parseDutyDate("20.10.26")).toBe("2026-10-20");
    expect(parseDutyDate("2026-10-20")).toBe("2026-10-20");
    expect(parseDutyDate("31.02.26")).toBeNull();
  });
});
