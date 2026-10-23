import { describe, expect, it } from "vitest";
import {
  dutyDateFromCell,
  monthInsertIndex,
  monthTabName,
  monthViewFormula,
  sheetSerialToIso,
} from "../src/services/months.js";

describe("month tabs", () => {
  it("names a duty date as year-month plus the month", () => {
    expect(monthTabName("2026-06-15")).toBe("2026-06 (JUNE)");
    expect(monthTabName("2026-12-01")).toBe("2026-12 (DECEMBER)");
  });

  it("returns nothing for a blank or unusable date", () => {
    expect(monthTabName("")).toBeNull();
    expect(monthTabName("not-a-date")).toBeNull();
    expect(monthTabName("2026-02-31")).toBeNull();
  });

  it("builds a filter that hides deleted rows and the following month", () => {
    const formula = monthViewFormula("Raw_Logs", 2026, 6);
    expect(formula).toContain("'Raw_Logs'");
    expect(formula).toContain('<>"DELETED"');
    expect(formula).toContain("DATE(2026,6,1)");
    expect(formula).toContain("DATE(2026,7,1)");
    expect(formula.startsWith("=IFERROR(SORT(FILTER(")).toBe(true);
  });

  it("rolls December into January of the next year", () => {
    const formula = monthViewFormula("Raw_Logs", 2026, 12);
    expect(formula).toContain("DATE(2026,12,1)");
    expect(formula).toContain("DATE(2027,1,1)");
  });

  it("quotes a raw tab name that contains spaces or quotes", () => {
    expect(monthViewFormula("Bob's Logs", 2026, 6)).toContain("'Bob''s Logs'");
  });

  it("converts a Sheets date serial from the 1899-12-30 epoch", () => {
    expect(sheetSerialToIso(46174)).toBe("2026-06-01");
    expect(dutyDateFromCell(46174)).toBe("2026-06-01");
    expect(dutyDateFromCell("2026-06-15")).toBe("2026-06-15");
    expect(dutyDateFromCell("")).toBeNull();
    expect(monthTabName(sheetSerialToIso(46174) ?? "")).toBe("2026-06 (JUNE)");
  });

  it("inserts a month tab in calendar order without moving other tabs", () => {
    const sheets = [
      { title: "Raw_Logs", index: 0 },
      { title: "Monthly", index: 1 },
      { title: "2026-10 (OCTOBER)", index: 2 },
    ];
    expect(monthInsertIndex(sheets, "2026-06 (JUNE)")).toBe(2);
    expect(monthInsertIndex(sheets, "2026-11 (NOVEMBER)")).toBe(3);
    expect(monthInsertIndex([{ title: "Raw_Logs", index: 0 }, { title: "Monthly", index: 1 }], "2026-06 (JUNE)")).toBe(2);
  });
});
