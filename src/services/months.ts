import { parseDutyDate } from "../parser/time.js";
import { COL, VIEW_HEADERS } from "./headers.js";

const MONTH_NAMES = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
] as const;

const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/** Titles this program creates, such as `2026-06 (JUNE)`. */
export const MONTH_TAB_TITLE = /^(\d{4})-(\d{2}) \([A-Z]+\)$/;

export interface MonthKey {
  year: number;
  month: number;
  title: string;
}

export interface SheetSlot {
  title: string;
  index: number;
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** `2026-06-15` becomes `2026-06 (JUNE)`. Anything that is not a real duty date becomes null. */
export function monthFromDutyDate(dutyDate: string): MonthKey | null {
  const iso = parseDutyDate(dutyDate.trim());
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match?.[1] || !match[2]) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const name = MONTH_NAMES[month - 1];
  if (!name) return null;
  return { year, month, title: `${match[1]}-${match[2]} (${name})` };
}

export function monthTabName(dutyDate: string): string | null {
  return monthFromDutyDate(dutyDate)?.title ?? null;
}

/** Sheets date serials count days from 1899-12-30. Text dates must already be `YYYY-MM-DD`. */
export function sheetSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const utc = new Date(SHEETS_EPOCH_MS + Math.round(serial) * DAY_MS);
  if (Number.isNaN(utc.getTime())) return null;
  const year = utc.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dutyDateFromCell(value: unknown): string | null {
  if (typeof value === "number") return sheetSerialToIso(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return parseDutyDate(trimmed);
}

function quoteSheet(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/** Live view of one month. Duty Date is view column 5, so SORT uses that column. */
export function monthViewFormula(rawTab: string, year: number, month: number): string {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const raw = quoteSheet(rawTab);
  const status = columnLetter(COL.status);
  const blockStart = columnLetter(COL.logName);
  const blockEnd = columnLetter(COL.notes);
  const duty = columnLetter(COL.dutyDate);
  const sortColumn = VIEW_HEADERS.indexOf("Duty Date") + 1;
  return (
    `=IFERROR(SORT(FILTER({${raw}!${status}2:${status},${raw}!${blockStart}2:${blockEnd}},` +
    `(${raw}!${status}2:${status}<>"DELETED")*` +
    `(${raw}!${duty}2:${duty}>=DATE(${year},${month},1))*` +
    `(${raw}!${duty}2:${duty}<DATE(${nextYear},${nextMonth},1))),${sortColumn},TRUE),"")`
  );
}

/** Place a new month tab among existing month tabs. Other tabs keep their relative positions. */
export function monthInsertIndex(sheets: readonly SheetSlot[], title: string): number {
  const later = sheets
    .filter((sheet) => MONTH_TAB_TITLE.test(sheet.title) && sheet.title > title)
    .sort((a, b) => a.index - b.index)[0];
  if (later) return later.index;
  const lastMonth = sheets
    .filter((sheet) => MONTH_TAB_TITLE.test(sheet.title))
    .reduce<SheetSlot | undefined>((last, sheet) => {
      if (!last || sheet.index > last.index) return sheet;
      return last;
    }, undefined);
  if (lastMonth) return lastMonth.index + 1;
  const maxIndex = sheets.reduce((max, sheet) => Math.max(max, sheet.index), -1);
  return maxIndex + 1;
}
