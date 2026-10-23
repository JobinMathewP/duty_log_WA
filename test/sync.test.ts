import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/env.js";
import { applyMessage, applyRevoke, type InboundMessage } from "../src/core/sync.js";
import { COL } from "../src/services/headers.js";
import {
  blankRow,
  type Cell,
  type SheetGateway,
  type SoftDeleteFields,
} from "../src/services/sheets.js";
import { StateStore } from "../src/services/state.js";
import { createLogger } from "../src/utils/logger.js";
import { CANONICAL_LOG } from "./sample.js";

class MemorySheets implements SheetGateway {
  rows: Cell[][] = [];
  monthViews: string[] = [];

  async ensureMonthView(dutyDate: string): Promise<void> {
    this.monthViews.push(dutyDate);
  }

  async appendRow(values: Cell[]): Promise<number> {
    this.rows.push([...values]);
    return this.rows.length + 1;
  }

  async getMessageId(row: number): Promise<string> {
    return String(this.rows[row - 2]?.[COL.messageId] ?? "");
  }

  async findRowByMessageId(messageId: string): Promise<number | null> {
    const index = this.rows.findIndex((row) => String(row[COL.messageId] ?? "") === messageId);
    return index === -1 ? null : index + 2;
  }

  async writeRow(row: number, values: Cell[]): Promise<void> {
    this.rows[row - 2] = [...values];
  }

  async readRow(row: number): Promise<Cell[]> {
    return [...(this.rows[row - 2] ?? blankRow())];
  }

  async updateExisting(
    messageId: string,
    cachedRow: number | undefined,
    values: Cell[],
  ): Promise<number | null> {
    let row: number | null = null;
    if (cachedRow && (await this.getMessageId(cachedRow)) === messageId) row = cachedRow;
    else row = await this.findRowByMessageId(messageId);
    if (row === null) return null;
    await this.writeRow(row, values);
    return row;
  }

  async softDeleteExisting(
    messageId: string,
    cachedRow: number | undefined,
    fields: SoftDeleteFields,
  ): Promise<number | null> {
    let row: number | null = null;
    if (cachedRow && (await this.getMessageId(cachedRow)) === messageId) row = cachedRow;
    else row = await this.findRowByMessageId(messageId);
    if (row === null) return null;
    const cells = this.rows[row - 2];
    if (!cells) return null;
    cells[COL.status] = fields.status;
    cells[COL.lastEventAt] = fields.lastEventAt;
    cells[COL.countableHours] = fields.countable;
    cells[COL.notes] = fields.notes;
    return row;
  }

  async patchNotes(row: number, add: string[]): Promise<void> {
    const cells = this.rows[row - 2];
    if (!cells) return;
    const current = String(cells[COL.notes] ?? "")
      .split(" | ")
      .filter((part) => part.length > 0);
    for (const note of add) {
      if (!current.includes(note)) current.push(note);
    }
    cells[COL.notes] = current.join(" | ");
  }

  async readDataRows() {
    return this.rows.map((cells, index) => ({ row: index + 2, cells: [...cells] }));
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-duty-"));
  tempDirs.push(dir);
  const config: AppConfig = {
    targetGroupIds: ["120363000000000000@g.us"],
    historicalFetchLimit: 300,
    hoursMismatchThreshold: 0.5,
    spreadsheetId: "sheet",
    sheetTabName: "Raw_Logs",
    serviceAccountKeyFile: "./credentials.json",
    geminiApiKey: "",
    geminiModel: "gemini-3.5-flash-lite",
    enableAiFallback: false,
    logLevel: "error",
    stateFilePath: path.join(dir, "sync_state.json"),
  };
  const sheets = new MemorySheets();
  const state = new StateStore(config.stateFilePath, createLogger("error", path.join(dir, "failed.log")));
  return { sheets, deps: { config, logger: createLogger("error", path.join(dir, "failed.log")), state, sheets } };
}

function message(id: string, body: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return {
    serializedId: `false_120363000000000000@g.us_${id}_971500000000@c.us`,
    shortId: id,
    chatId: "120363000000000000@g.us",
    senderName: "Nagarajan",
    senderId: "971500000000@c.us",
    body,
    timestamp: 1_761_000_000,
    type: "chat",
    isForwarded: false,
    ...extra,
  };
}

function log(options: { site?: string; technician?: string; total?: string }): string {
  return [
    "Nagarajan. Tuesday",
    `Site: ${options.site ?? "Al barsha NS147"}`,
    "Date: 20.10.26",
    "Start duty : 6.53",
    "Pause duty : 1.43pm",
    "Resume duty : 2.38pm",
    "Finish duty: 5.04",
    `Total working hrs: ${options.total ?? "9 Hrs"}`,
    `Technician: ${options.technician ?? "Arjun"}`,
  ].join("\n");
}

describe("sync", () => {
  it("appends a log once and ignores the same body", async () => {
    const { sheets, deps } = await harness();
    const inbound = message("AAA", CANONICAL_LOG);
    expect(await applyMessage(inbound, deps)).toBe("appended");
    expect(await applyMessage(inbound, deps)).toBe("ignored");
    expect(sheets.rows).toHaveLength(1);
    expect(sheets.monthViews).toEqual(["2026-10-20"]);
    expect(sheets.rows[0]?.[COL.status]).toBe("ACTIVE");
    expect(sheets.rows[0]?.[COL.countableHours]).toBe(9);
    expect(sheets.rows[0]?.[COL.reportedHours]).toBe(9);
    expect(deps.state.get(inbound.serializedId)?.row).toBe(2);
  });

  it("updates the same row when the body changes", async () => {
    const { sheets, deps } = await harness();
    const inbound = message("BBB", CANONICAL_LOG);
    await applyMessage(inbound, deps);
    const edited = message("BBB", CANONICAL_LOG.replace("9 Hrs", "10 Hrs"));
    expect(await applyMessage(edited, deps)).toBe("updated");
    expect(sheets.monthViews).toEqual(["2026-10-20", "2026-10-20"]);
    expect(sheets.rows).toHaveLength(1);
    expect(sheets.rows[0]?.[COL.status]).toBe("EDITED");
    expect(sheets.rows[0]?.[COL.reportedHours]).toBe(10);
    expect(sheets.rows[0]?.[COL.countableHours]).toBe(10);
  });

  it("keeps reported hours and zeroes countable hours on delete", async () => {
    const { sheets, deps } = await harness();
    const inbound = message("CCC", CANONICAL_LOG);
    await applyMessage(inbound, deps);
    expect(await applyRevoke(inbound.serializedId, deps)).toBe("deleted");
    expect(sheets.monthViews).toEqual(["2026-10-20"]);
    expect(sheets.rows).toHaveLength(1);
    expect(sheets.rows[0]?.[COL.status]).toBe("DELETED");
    expect(sheets.rows[0]?.[COL.reportedHours]).toBe(9);
    expect(sheets.rows[0]?.[COL.countableHours]).toBe(0);
    expect(sheets.rows[0]?.[COL.site]).toBe("Al barsha NS147");
  });

  it("does not resurrect a deleted log", async () => {
    const { sheets, deps } = await harness();
    const inbound = message("DDD", CANONICAL_LOG);
    await applyMessage(inbound, deps);
    await applyRevoke(inbound.shortId, deps);
    const again = message("DDD", CANONICAL_LOG.replace("9 Hrs", "12 Hrs"));
    expect(await applyMessage(again, deps)).toBe("ignored");
    expect(sheets.rows).toHaveLength(1);
    expect(sheets.rows[0]?.[COL.status]).toBe("DELETED");
    expect(sheets.rows[0]?.[COL.reportedHours]).toBe(9);
    expect(sheets.rows[0]?.[COL.countableHours]).toBe(0);
  });

  it("ignores a revoke for an unknown message", async () => {
    const { sheets, deps } = await harness();
    expect(await applyRevoke("missing", deps)).toBe("ignored");
    expect(sheets.rows).toHaveLength(0);
  });

  it("flags both rows when the same sender posts the same site and date again", async () => {
    const { sheets, deps } = await harness();
    await applyMessage(message("E1", log({ technician: "Arjun" })), deps);
    await applyMessage(
      message("E2", log({ technician: "Vicky" }), { senderId: "971500000000@c.us" }),
      deps,
    );
    expect(String(sheets.rows[0]?.[COL.notes])).toContain("POSSIBLE_DUPLICATE");
    expect(String(sheets.rows[1]?.[COL.notes])).toContain("POSSIBLE_DUPLICATE");
    expect(String(sheets.rows[0]?.[COL.notes])).not.toContain("OVERLAP");
  });

  it("flags an overlapping technician on the same duty date", async () => {
    const { sheets, deps } = await harness();
    await applyMessage(message("F1", log({ site: "Al barsha NS147", technician: "Arjun" })), deps);
    await applyMessage(message("F2", log({ site: "Other Site", technician: "Arjun" })), deps);
    expect(String(sheets.rows[0]?.[COL.notes])).toContain("OVERLAP");
    expect(String(sheets.rows[1]?.[COL.notes])).toContain("OVERLAP");
    expect(String(sheets.rows[1]?.[COL.notes])).not.toContain("POSSIBLE_DUPLICATE");
  });

  it("repairs a stale cached row before updating", async () => {
    const { sheets, deps } = await harness();
    const inbound = message("G1", CANONICAL_LOG);
    await applyMessage(inbound, deps);
    const dummy = blankRow();
    dummy[COL.messageId] = "someone-else";
    sheets.rows.unshift(dummy);
    const edited = message("G1", CANONICAL_LOG.replace("9 Hrs", "10 Hrs"));
    await applyMessage(edited, deps);
    expect(sheets.rows[0]?.[COL.messageId]).toBe("someone-else");
    expect(sheets.rows[1]?.[COL.status]).toBe("EDITED");
    expect(deps.state.get(inbound.serializedId)?.row).toBe(3);
  });

  it("ignores ordinary chat", async () => {
    const { sheets, deps } = await harness();
    expect(await applyMessage(message("H1", "what site is the technician at?"), deps)).toBe("ignored");
    expect(sheets.rows).toHaveLength(0);
  });
});
