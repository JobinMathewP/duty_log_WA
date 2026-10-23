import type { AppConfig } from "../config/env.js";
import { parseMessage } from "../parser/index.js";
import { countableHours, isClean } from "../parser/record.js";
import { staffNames } from "../parser/time.js";
import type { Note } from "../parser/types.js";
import type { Logger } from "../utils/logger.js";
import { toCells, type SheetGateway } from "../services/sheets.js";
import {
  bodyHash,
  normalizeSite,
  type StateRecord,
  type StateStore,
} from "../services/state.js";

export interface InboundMessage {
  serializedId: string;
  shortId: string;
  chatId: string;
  senderName: string;
  senderId: string;
  body: string;
  timestamp: number;
  type: string;
  isForwarded: boolean;
}

export interface SyncDeps {
  config: AppConfig;
  logger: Logger;
  state: StateStore;
  sheets: SheetGateway;
}

export type ApplyResult = "appended" | "updated" | "deleted" | "ignored";

function mergeNotes(base: Note[], extra: Note[]): Note[] {
  const notes = [...base];
  for (const note of extra) {
    if (!notes.includes(note)) notes.push(note);
  }
  return notes;
}

async function softDelete(id: string, existing: StateRecord, deps: SyncDeps): Promise<void> {
  const row = await deps.sheets.softDeleteExisting(id, existing.row, {
    status: "DELETED",
    lastEventAt: new Date().toISOString(),
    countable: 0,
    notes: existing.notes.join(" | "),
  });
  if (row === null) {
    deps.logger.warn("deleted message has no sheet row", { id });
    await deps.state.markDeleted(id, existing.row);
    return;
  }
  await deps.state.markDeleted(id, row);
  deps.logger.info("marked duty log deleted", { id, row });
}

export async function applyMessage(message: InboundMessage, deps: SyncDeps): Promise<ApplyResult> {
  if (!message.serializedId) return "ignored";
  return deps.state.withId(message.serializedId, async () => {
    const existing = deps.state.get(message.serializedId);
    if (existing?.status === "DELETED") return "ignored";
    if (message.type === "revoked") {
      if (!existing) return "ignored";
      await softDelete(message.serializedId, existing, deps);
      return "deleted";
    }

    const hash = bodyHash(message.body);
    if (existing && existing.bodyHash === hash) return "ignored";

    const parsed = await parseMessage(message.body, {
      hoursMismatchThreshold: deps.config.hoursMismatchThreshold,
      enableAiFallback: deps.config.enableAiFallback,
      geminiApiKey: deps.config.geminiApiKey,
      geminiModel: deps.config.geminiModel,
    });
    if (!parsed) return "ignored";
    if (!isClean(parsed)) {
      await deps.logger.appendFailed(message.body, "needs_review");
    }

    const relations = deps.state.relationNotes(message.serializedId, {
      senderId: message.senderId,
      site: parsed.site,
      dutyDate: parsed.dutyDate,
      names: staffNames(parsed.technicians, parsed.associates),
      startMinute: parsed.startMinute,
      endMinute: parsed.endMinute,
    });
    const notes = mergeNotes(parsed.notes, relations.self);
    if (message.isForwarded && !notes.includes("FORWARDED")) notes.push("FORWARDED");

    const status = existing ? "EDITED" : parsed.status;
    const countable = countableHours(status, parsed.reportedHours, parsed.calculatedHours);
    const record = { ...parsed, status, notes, countableHours: countable };
    const postedAt =
      message.timestamp > 0 ? new Date(message.timestamp * 1000).toISOString() : "";
    const cells = toCells({
      status,
      lastEventAt: new Date().toISOString(),
      messageId: message.serializedId,
      groupId: message.chatId,
      senderName: message.senderName,
      senderId: message.senderId,
      record,
      postedAt,
      notes,
    });

    let row: number;
    if (existing) {
      const updated = await deps.sheets.updateExisting(message.serializedId, existing.row, cells);
      row = updated ?? (await deps.sheets.appendRow(cells));
    } else {
      row = await deps.sheets.appendRow(cells);
    }

    await deps.state.saveRecord(message.serializedId, {
      shortId: message.shortId,
      row,
      status,
      bodyHash: hash,
      dutyDate: parsed.dutyDate,
      site: normalizeSite(parsed.site),
      senderId: message.senderId,
      names: staffNames(parsed.technicians, parsed.associates),
      startMinute: parsed.startMinute,
      endMinute: parsed.endMinute,
      updatedAt: new Date().toISOString(),
      notes,
    });

    for (const peer of relations.peers) {
      const peerRecord = deps.state.get(peer.id);
      if (!peerRecord) continue;
      try {
        await deps.sheets.patchNotes(peerRecord.row, peer.add);
        await deps.state.addNotes(peer.id, peer.add);
      } catch (error) {
        deps.logger.error("peer note update failed", { id: peer.id, error: String(error) });
      }
    }

    if (parsed.dutyDate) {
      try {
        await deps.sheets.ensureMonthView(parsed.dutyDate);
      } catch (error) {
        deps.logger.error("month tab failed", {
          id: message.serializedId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    deps.logger.info(existing ? "updated duty log" : "appended duty log", {
      id: message.serializedId,
      row,
      status,
      site: parsed.site,
    });
    return existing ? "updated" : "appended";
  });
}

export async function applyRevoke(idOrShort: string, deps: SyncDeps): Promise<ApplyResult> {
  const serialized = deps.state.resolve(idOrShort);
  if (!serialized) {
    deps.logger.info("revoke ignored", { id: idOrShort });
    return "ignored";
  }
  const existing = deps.state.get(serialized);
  return applyMessage(
    {
      serializedId: serialized,
      shortId: existing?.shortId ?? "",
      chatId: "",
      senderName: "",
      senderId: "",
      body: "",
      timestamp: 0,
      type: "revoked",
      isForwarded: false,
    },
    deps,
  );
}
