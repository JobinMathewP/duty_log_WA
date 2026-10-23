import { Mutex } from "async-mutex";
import { google, type sheets_v4 } from "googleapis";
import type { AppConfig } from "../config/env.js";
import type { DutyLogRecord, Note, Status } from "../parser/types.js";
import { staffNames } from "../parser/time.js";
import type { Logger } from "../utils/logger.js";
import { COL, HEADERS, VIEW_HEADERS } from "./headers.js";
import {
  columnLetter,
  dutyDateFromCell,
  monthFromDutyDate,
  monthInsertIndex,
  monthViewFormula,
  type MonthKey,
} from "./months.js";
import {
  bodyHash,
  emptyState,
  normalizeSite,
  parseNotes,
  parseStatus,
  type StateRecord,
  type SyncState,
} from "./state.js";

export type Cell = string | number;

export interface SheetRow {
  row: number;
  cells: Cell[];
}

export interface SoftDeleteFields {
  status: Status;
  lastEventAt: string;
  countable: number;
  notes: string;
}

export interface SheetGateway {
  appendRow(values: Cell[]): Promise<number>;
  getMessageId(row: number): Promise<string>;
  findRowByMessageId(messageId: string): Promise<number | null>;
  writeRow(row: number, values: Cell[]): Promise<void>;
  readRow(row: number): Promise<Cell[]>;
  softDeleteExisting(
    messageId: string,
    cachedRow: number | undefined,
    fields: SoftDeleteFields,
  ): Promise<number | null>;
  updateExisting(
    messageId: string,
    cachedRow: number | undefined,
    values: Cell[],
  ): Promise<number | null>;
  patchNotes(row: number, add: string[]): Promise<void>;
  readDataRows(): Promise<SheetRow[]>;
  ensureMonthView(dutyDate: string): Promise<void>;
}

export interface StoredLog {
  status: Status;
  lastEventAt: string;
  messageId: string;
  groupId: string;
  senderName: string;
  senderId: string;
  record: DutyLogRecord;
  postedAt: string;
  notes: Note[];
}

export function blankRow(): Cell[] {
  return Array.from({ length: HEADERS.length }, () => "");
}

export function toCells(input: StoredLog): Cell[] {
  const cells = blankRow();
  const record = input.record;
  cells[COL.status] = input.status;
  cells[COL.lastEventAt] = input.lastEventAt;
  cells[COL.messageId] = input.messageId;
  cells[COL.groupId] = input.groupId;
  cells[COL.senderName] = input.senderName;
  cells[COL.senderId] = input.senderId;
  cells[COL.logName] = record.logName;
  cells[COL.weekday] = record.weekday;
  cells[COL.site] = record.site;
  cells[COL.dutyDate] = record.dutyDate;
  cells[COL.start] = record.start;
  cells[COL.pause] = record.pause;
  cells[COL.resume] = record.resume;
  cells[COL.finish] = record.finish;
  cells[COL.reportedHours] = record.reportedHours ?? "";
  cells[COL.calculatedHours] = record.calculatedHours ?? "";
  cells[COL.countableHours] = input.record.countableHours;
  cells[COL.technicians] = record.technicians;
  cells[COL.associates] = record.associates;
  cells[COL.notes] = input.notes.join(" | ");
  cells[COL.postedAt] = input.postedAt;
  cells[COL.parser] = record.parser;
  cells[COL.raw] = record.raw;
  return cells;
}

export function rowFromUpdatedRange(updatedRange: string | null | undefined): number {
  const match = updatedRange?.match(/![A-Z]+(\d+)/i);
  const row = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(row) || row < 2) {
    throw new Error(`Sheets append did not return a data row: ${updatedRange ?? "(empty)"}`);
  }
  return row;
}

export function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { code?: unknown; response?: { status?: unknown } };
  const code = record.response?.status ?? record.code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  return undefined;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  delays: number[] = [2000, 4000, 8000],
  logger?: Logger,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < delays.length + 1; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const status = httpStatus(error);
      const retryable = status === 429 || (status !== undefined && status >= 500 && status <= 599);
      const delay = delays[attempt];
      if (!retryable || delay === undefined) throw error;
      logger?.warn("sheets retry", { status, delay });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw last;
}

function asCells(row: unknown[] | undefined): Cell[] {
  const cells = blankRow();
  if (!row) return cells;
  for (let index = 0; index < HEADERS.length; index += 1) {
    const value = row[index];
    if (typeof value === "number" && Number.isFinite(value)) cells[index] = value;
    else if (value === undefined || value === null) cells[index] = "";
    else cells[index] = String(value);
  }
  return cells;
}

function minutesFromCell(value: Cell | undefined): number | null {
  if (typeof value === "number" && value >= 0 && value < 1) return Math.round(value * 24 * 60);
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  if (!match?.[1] || !match[2]) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  return hour * 60 + minute;
}

export function rowsToState(rows: SheetRow[]): SyncState {
  const state = emptyState();
  for (const { row, cells } of rows) {
    const messageId = String(cells[COL.messageId] ?? "");
    if (!messageId) continue;
    const parts = messageId.split("_");
    const shortId = parts.length >= 4 ? (parts[2] ?? messageId) : messageId;
    const technicians = String(cells[COL.technicians] ?? "");
    const associates = String(cells[COL.associates] ?? "");
    const record: StateRecord = {
      shortId,
      row,
      status: parseStatus(cells[COL.status]),
      bodyHash: bodyHash(String(cells[COL.raw] ?? "")),
      dutyDate: String(cells[COL.dutyDate] ?? ""),
      site: normalizeSite(String(cells[COL.site] ?? "")),
      senderId: String(cells[COL.senderId] ?? ""),
      names: staffNames(technicians, associates),
      startMinute: minutesFromCell(cells[COL.start]),
      endMinute: minutesFromCell(cells[COL.finish]),
      updatedAt: String(cells[COL.lastEventAt] ?? ""),
      notes: parseNotes(cells[COL.notes]),
    };
    state.records[messageId] = record;
    if (shortId) state.byShortId[shortId] = messageId;
  }
  return state;
}

function quoteTab(tab: string, range: string): string {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}

interface SheetSlot {
  title: string;
  index: number;
  sheetId: number;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAlreadyExists(error: unknown): boolean {
  return errorText(error).toLowerCase().includes("already exists");
}

async function resolveRow(
  sheets: Pick<SheetGateway, "getMessageId" | "findRowByMessageId">,
  messageId: string,
  cachedRow: number | undefined,
): Promise<number | null> {
  if (cachedRow && cachedRow > 1) {
    const current = await sheets.getMessageId(cachedRow);
    if (current === messageId) return cachedRow;
  }
  return sheets.findRowByMessageId(messageId);
}

export class GoogleSheets implements SheetGateway {
  private readonly api: sheets_v4.Sheets;
  private readonly monthLock = new Mutex();
  private readonly creating = new Map<string, Promise<void>>();
  private readonly readyMonths = new Set<string>();
  private readonly needsInstall = new Set<string>();
  private snapshot: SheetSlot[] | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.serviceAccountKeyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.api = google.sheets({ version: "v4", auth });
  }

  async ping(): Promise<string> {
    const meta = await withRetry(
      () =>
        this.api.spreadsheets.get({
          spreadsheetId: this.config.spreadsheetId,
          fields: "properties.title",
        }),
      undefined,
      this.logger,
    );
    return meta.data.properties?.title ?? "(untitled)";
  }

  async ensureTabAndHeader(): Promise<void> {
    const tab = this.config.sheetTabName;
    const meta = await withRetry(
      () => this.api.spreadsheets.get({ spreadsheetId: this.config.spreadsheetId }),
      undefined,
      this.logger,
    );
    let sheetId = meta.data.sheets?.find((sheet) => sheet.properties?.title === tab)?.properties
      ?.sheetId;
    if (sheetId === undefined || sheetId === null) {
      const created = await withRetry(
        () =>
          this.api.spreadsheets.batchUpdate({
            spreadsheetId: this.config.spreadsheetId,
            requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
          }),
        undefined,
        this.logger,
      );
      sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId;
    }
    if (sheetId === undefined || sheetId === null) {
      throw new Error(`Could not create or find the ${tab} tab`);
    }

    const header = await withRetry(
      () =>
        this.api.spreadsheets.values.get({
          spreadsheetId: this.config.spreadsheetId,
          range: quoteTab(tab, "A1:A1"),
        }),
      undefined,
      this.logger,
    );
    const first = header.data.values?.[0]?.[0];
    if (first !== HEADERS[0]) {
      if (first !== undefined && first !== "") {
        throw new Error(
          `${tab}!A1 is "${String(first)}", not "${HEADERS[0]}". Refusing to overwrite an existing header.`,
        );
      }
      await withRetry(
        () =>
          this.api.spreadsheets.values.update({
            spreadsheetId: this.config.spreadsheetId,
            range: quoteTab(tab, "A1:W1"),
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [HEADERS] },
          }),
        undefined,
        this.logger,
      );
    }

    await withRetry(
      () =>
        this.api.spreadsheets.batchUpdate({
          spreadsheetId: this.config.spreadsheetId,
          requestBody: {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                  fields: "gridProperties.frozenRowCount",
                },
              },
            ],
          },
        }),
      undefined,
      this.logger,
    );
  }

  async appendRow(values: Cell[]): Promise<number> {
    const response = await withRetry(
      () =>
        this.api.spreadsheets.values.append({
          spreadsheetId: this.config.spreadsheetId,
          range: quoteTab(this.config.sheetTabName, "A:W"),
          valueInputOption: "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: [values] },
        }),
      undefined,
      this.logger,
    );
    return rowFromUpdatedRange(response.data.updates?.updatedRange);
  }

  async getMessageId(row: number): Promise<string> {
    const response = await withRetry(
      () =>
        this.api.spreadsheets.values.get({
          spreadsheetId: this.config.spreadsheetId,
          range: quoteTab(this.config.sheetTabName, `C${row}`),
        }),
      undefined,
      this.logger,
    );
    return String(response.data.values?.[0]?.[0] ?? "");
  }

  async findRowByMessageId(messageId: string): Promise<number | null> {
    const response = await withRetry(
      () =>
        this.api.spreadsheets.values.get({
          spreadsheetId: this.config.spreadsheetId,
          range: quoteTab(this.config.sheetTabName, "C2:C"),
        }),
      undefined,
      this.logger,
    );
    const values = response.data.values ?? [];
    for (let index = 0; index < values.length; index += 1) {
      if (String(values[index]?.[0] ?? "") === messageId) return index + 2;
    }
    return null;
  }

  async writeRow(row: number, values: Cell[]): Promise<void> {
    await withRetry(
      () =>
        this.api.spreadsheets.values.update({
          spreadsheetId: this.config.spreadsheetId,
          range: quoteTab(this.config.sheetTabName, `A${row}:W${row}`),
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [values] },
        }),
      undefined,
      this.logger,
    );
  }

  async readRow(row: number): Promise<Cell[]> {
    const response = await withRetry(
      () =>
        this.api.spreadsheets.values.get({
          spreadsheetId: this.config.spreadsheetId,
          range: quoteTab(this.config.sheetTabName, `A${row}:W${row}`),
          valueRenderOption: "FORMATTED_VALUE",
        }),
      undefined,
      this.logger,
    );
    return asCells(response.data.values?.[0]);
  }

  async updateExisting(
    messageId: string,
    cachedRow: number | undefined,
    values: Cell[],
  ): Promise<number | null> {
    const row = await resolveRow(this, messageId, cachedRow);
    if (row === null) return null;
    await this.writeRow(row, values);
    return row;
  }

  async softDeleteExisting(
    messageId: string,
    cachedRow: number | undefined,
    fields: SoftDeleteFields,
  ): Promise<number | null> {
    const row = await resolveRow(this, messageId, cachedRow);
    if (row === null) return null;
    const tab = this.config.sheetTabName;
    await withRetry(
      () =>
        this.api.spreadsheets.values.batchUpdate({
          spreadsheetId: this.config.spreadsheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: [
              { range: quoteTab(tab, `A${row}`), values: [[fields.status]] },
              { range: quoteTab(tab, `B${row}`), values: [[fields.lastEventAt]] },
              { range: quoteTab(tab, `Q${row}`), values: [[fields.countable]] },
              { range: quoteTab(tab, `T${row}`), values: [[fields.notes]] },
            ],
          },
        }),
      undefined,
      this.logger,
    );
    return row;
  }

  async patchNotes(row: number, add: string[]): Promise<void> {
    if (add.length === 0) return;
    const cells = await this.readRow(row);
    const current = String(cells[COL.notes] ?? "")
      .split(" | ")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    let changed = false;
    for (const note of add) {
      if (!current.includes(note)) {
        current.push(note);
        changed = true;
      }
    }
    if (!changed) return;
    cells[COL.notes] = current.join(" | ");
    await this.writeRow(row, cells);
  }

  async readDataRows(): Promise<SheetRow[]> {
    const response = await withRetry(
      () =>
        this.api.spreadsheets.values.get({
          spreadsheetId: this.config.spreadsheetId,
          range: quoteTab(this.config.sheetTabName, "A2:W"),
          valueRenderOption: "FORMATTED_VALUE",
        }),
      undefined,
      this.logger,
    );
    const values = response.data.values ?? [];
    return values.map((row, index) => ({ row: index + 2, cells: asCells(row) }));
  }

  async rebuildState(): Promise<SyncState> {
    const rows = await this.readDataRows();
    return rowsToState(rows);
  }

  async ensureMonthView(dutyDate: string): Promise<void> {
    const month = monthFromDutyDate(dutyDate);
    if (!month) return;
    if (this.readyMonths.has(month.title)) return;
    const pending = this.creating.get(month.title);
    if (pending) return pending;

    let resolveJob!: () => void;
    let rejectJob!: (error: unknown) => void;
    const job = new Promise<void>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    void job.catch(() => undefined);
    this.creating.set(month.title, job);
    try {
      await this.monthLock.runExclusive(() => this.createMonthTabIfMissing(month));
      resolveJob();
    } catch (error) {
      rejectJob(error);
      throw error;
    } finally {
      this.creating.delete(month.title);
    }
  }

  async ensureExistingMonthViews(): Promise<void> {
    const response = await withRetry(
      () =>
        this.api.spreadsheets.values.get({
          spreadsheetId: this.config.spreadsheetId,
          range: quoteTab(this.config.sheetTabName, "A2:J"),
          valueRenderOption: "UNFORMATTED_VALUE",
        }),
      undefined,
      this.logger,
    );
    const seen = new Set<string>();
    for (const row of response.data.values ?? []) {
      if (String(row[COL.status] ?? "") === "DELETED") continue;
      const dutyDate = dutyDateFromCell(row[COL.dutyDate]);
      if (!dutyDate || seen.has(dutyDate.slice(0, 7))) continue;
      seen.add(dutyDate.slice(0, 7));
      await this.ensureMonthView(dutyDate);
    }
    this.logger.info("month tabs checked", { months: seen.size });
  }

  private async createMonthTabIfMissing(month: MonthKey): Promise<void> {
    if (this.readyMonths.has(month.title)) return;
    if (!this.snapshot) this.snapshot = await this.fetchSheets();
    let sheet = this.snapshot.find((slot) => slot.title === month.title);
    let created = false;
    if (!sheet) {
      const index = monthInsertIndex(this.snapshot, month.title);
      try {
        sheet = await this.addMonthSheet(month.title, index);
        created = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        this.snapshot = await this.fetchSheets();
        sheet = this.snapshot.find((slot) => slot.title === month.title);
        if (!sheet) throw error;
      }
    }
    try {
      if (created || this.needsInstall.has(month.title)) {
        await this.writeMonthView(month);
        await this.formatMonthView(sheet.sheetId);
        this.needsInstall.delete(month.title);
      } else {
        const top = await this.monthTop(month.title);
        const foreign = top.header !== "" && top.header !== VIEW_HEADERS[0];
        const broken = top.formula === "" || top.shown === "#ERROR!";
        if (!foreign && broken) await this.writeMonthView(month);
        if (!foreign) await this.formatMonthColumns(sheet.sheetId);
      }
    } catch (error) {
      this.needsInstall.add(month.title);
      throw error;
    }
    this.readyMonths.add(month.title);
  }

  private async fetchSheets(): Promise<SheetSlot[]> {
    const meta = await withRetry(
      () =>
        this.api.spreadsheets.get({
          spreadsheetId: this.config.spreadsheetId,
          fields: "sheets.properties(sheetId,title,index)",
        }),
      undefined,
      this.logger,
    );
    const slots: SheetSlot[] = [];
    for (const sheet of meta.data.sheets ?? []) {
      const title = sheet.properties?.title;
      const sheetId = sheet.properties?.sheetId;
      const index = sheet.properties?.index;
      if (!title || sheetId === undefined || sheetId === null || index === undefined || index === null) {
        continue;
      }
      slots.push({ title, sheetId, index });
    }
    return slots;
  }

  private async addMonthSheet(title: string, index: number): Promise<SheetSlot> {
    const created = await withRetry(
      () =>
        this.api.spreadsheets.batchUpdate({
          spreadsheetId: this.config.spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title, index } } }],
          },
        }),
      undefined,
      this.logger,
    );
    const props = created.data.replies?.[0]?.addSheet?.properties;
    const sheetId = props?.sheetId;
    if (sheetId === undefined || sheetId === null) {
      throw new Error(`Could not create the ${title} tab`);
    }
    const actualIndex = props?.index ?? index;
    const slot = { title, sheetId, index: actualIndex };
    this.rememberSheet(slot);
    return slot;
  }

  private rememberSheet(slot: SheetSlot): void {
    if (!this.snapshot) this.snapshot = [];
    for (const sheet of this.snapshot) {
      if (sheet.index >= slot.index) sheet.index += 1;
    }
    this.snapshot.push(slot);
  }

  private async monthTop(title: string): Promise<{ header: string; formula: string; shown: string }> {
    const response = await withRetry(
      () =>
        this.api.spreadsheets.get({
          spreadsheetId: this.config.spreadsheetId,
          ranges: [quoteTab(title, "A1:A2")],
          includeGridData: true,
          fields: "sheets.data.rowData.values(formattedValue,userEnteredValue)",
        }),
      undefined,
      this.logger,
    );
    const rows = response.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    return {
      header: rows[0]?.values?.[0]?.formattedValue ?? "",
      formula: rows[1]?.values?.[0]?.userEnteredValue?.formulaValue ?? "",
      shown: rows[1]?.values?.[0]?.formattedValue ?? "",
    };
  }

  /** USER_ENTERED is required. formulaValue rejects this array literal with a parse error. */
  private async writeMonthView(month: MonthKey): Promise<void> {
    const formula = monthViewFormula(this.config.sheetTabName, month.year, month.month);
    const end = columnLetter(VIEW_HEADERS.length - 1);
    await withRetry(
      () =>
        this.api.spreadsheets.values.batchUpdate({
          spreadsheetId: this.config.spreadsheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: [
              { range: quoteTab(month.title, `A1:${end}1`), values: [Array.from(VIEW_HEADERS)] },
              { range: quoteTab(month.title, "A2"), values: [[formula]] },
            ],
          },
        }),
      undefined,
      this.logger,
    );
    this.logger.info("month tab ready", { tab: month.title });
  }

  private async formatMonthColumns(sheetId: number): Promise<void> {
    const duty = VIEW_HEADERS.indexOf("Duty Date");
    const start = VIEW_HEADERS.indexOf("Start");
    const finish = VIEW_HEADERS.indexOf("Finish");
    const numberFormat = (
      startColumnIndex: number,
      endColumnIndex: number,
      type: "DATE" | "TIME",
      pattern: string,
    ) => ({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex, endColumnIndex },
        cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
    await withRetry(
      () =>
        this.api.spreadsheets.batchUpdate({
          spreadsheetId: this.config.spreadsheetId,
          requestBody: {
            requests: [
              numberFormat(duty, duty + 1, "DATE", "yyyy-mm-dd"),
              numberFormat(start, finish + 1, "TIME", "hh:mm"),
            ],
          },
        }),
      undefined,
      this.logger,
    );
  }

  private async formatMonthView(sheetId: number): Promise<void> {
    await this.formatMonthColumns(sheetId);
    await withRetry(
      () =>
        this.api.spreadsheets.batchUpdate({
          spreadsheetId: this.config.spreadsheetId,
          requestBody: {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                  fields: "gridProperties.frozenRowCount",
                },
              },
              {
                addConditionalFormatRule: {
                  index: 0,
                  rule: {
                    ranges: [
                      {
                        sheetId,
                        startRowIndex: 1,
                        startColumnIndex: 0,
                        endColumnIndex: VIEW_HEADERS.length,
                      },
                    ],
                    booleanRule: {
                      condition: {
                        type: "CUSTOM_FORMULA",
                        values: [{ userEnteredValue: '=$A2="NEEDS_REVIEW"' }],
                      },
                      format: {
                        backgroundColor: { red: 1, green: 0.95, blue: 0.6 },
                      },
                    },
                  },
                },
              },
            ],
          },
        }),
      undefined,
      this.logger,
    );
  }
}
