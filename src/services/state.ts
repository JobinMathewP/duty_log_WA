import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Mutex } from "async-mutex";
import type { Note, Status } from "../parser/types.js";
import { isNote } from "../parser/types.js";
import type { Logger } from "../utils/logger.js";

export interface StateRecord {
  shortId: string;
  row: number;
  status: Status;
  bodyHash: string;
  dutyDate: string;
  site: string;
  senderId: string;
  names: string[];
  startMinute: number | null;
  endMinute: number | null;
  updatedAt: string;
  notes: Note[];
}

export interface SyncState {
  last_sync_timestamp: number;
  records: Record<string, StateRecord>;
  byShortId: Record<string, string>;
}

export interface RelationInput {
  senderId: string;
  site: string;
  dutyDate: string;
  names: string[];
  startMinute: number | null;
  endMinute: number | null;
}

export interface RelationResult {
  self: Note[];
  peers: Array<{ id: string; add: Note[] }>;
}

export function emptyState(): SyncState {
  return { last_sync_timestamp: 0, records: {}, byShortId: {} };
}

export function bodyHash(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function normalizeSite(site: string): string {
  return site.trim().toLowerCase();
}

export function relationNotes(data: SyncState, selfId: string, incoming: RelationInput): RelationResult {
  const self: Note[] = [];
  const peers: Array<{ id: string; add: Note[] }> = [];
  let duplicate = false;
  let overlap = false;
  const site = normalizeSite(incoming.site);

  for (const [id, other] of Object.entries(data.records)) {
    if (id === selfId) continue;
    if (other.status !== "ACTIVE" && other.status !== "EDITED") continue;
    const add: Note[] = [];
    const sameLog =
      incoming.senderId.length > 0 &&
      other.senderId === incoming.senderId &&
      site.length > 0 &&
      other.site === site &&
      incoming.dutyDate.length > 0 &&
      other.dutyDate === incoming.dutyDate;
    if (sameLog) {
      duplicate = true;
      if (!other.notes.includes("POSSIBLE_DUPLICATE")) add.push("POSSIBLE_DUPLICATE");
    }
    const intervals =
      incoming.dutyDate.length > 0 &&
      other.dutyDate === incoming.dutyDate &&
      incoming.startMinute !== null &&
      incoming.endMinute !== null &&
      other.startMinute !== null &&
      other.endMinute !== null &&
      incoming.names.some((name) => other.names.includes(name)) &&
      incoming.startMinute < other.endMinute &&
      other.startMinute < incoming.endMinute;
    if (intervals) {
      overlap = true;
      if (!other.notes.includes("OVERLAP")) add.push("OVERLAP");
    }
    if (add.length > 0) peers.push({ id, add });
  }

  if (duplicate) self.push("POSSIBLE_DUPLICATE");
  if (overlap) self.push("OVERLAP");
  return { self, peers };
}

export function parseStatus(value: unknown): Status {
  const text = String(value ?? "");
  if (text === "ACTIVE" || text === "EDITED" || text === "DELETED" || text === "NEEDS_REVIEW") {
    return text;
  }
  return "ACTIVE";
}

export function parseNotes(value: unknown): Note[] {
  return String(value ?? "")
    .split(" | ")
    .map((part) => part.trim())
    .filter(isNote);
}

export class StateStore {
  private data: SyncState = emptyState();
  private readonly locks = new Map<string, Mutex>();
  private readonly fileMutex = new Mutex();

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  getLastSync(): number {
    return this.data.last_sync_timestamp;
  }

  get(id: string): StateRecord | undefined {
    return this.data.records[id];
  }

  snapshot(): SyncState {
    return this.data;
  }

  resolve(id: string): string | null {
    if (this.data.records[id]) return id;
    return this.data.byShortId[id] ?? null;
  }

  relationNotes(selfId: string, incoming: RelationInput): RelationResult {
    return relationNotes(this.data, selfId, incoming);
  }

  replace(next: SyncState): void {
    this.data = next;
  }

  async withId<T>(id: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.locks.get(id);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(id, mutex);
    }
    return mutex.runExclusive(fn);
  }

  /** Loads the file. Returns false when it is missing or unreadable so the caller can rebuild from the sheet. */
  async tryLoad(): Promise<boolean> {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !("records" in parsed)) {
        throw new Error("state file is missing records");
      }
      const record = parsed as Partial<SyncState>;
      this.data = {
        last_sync_timestamp:
          typeof record.last_sync_timestamp === "number" ? record.last_sync_timestamp : 0,
        records: record.records ?? {},
        byShortId: record.byShortId ?? {},
      };
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      const aside = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, aside).catch(() => undefined);
      this.logger.error("state file unreadable", { aside });
      this.data = emptyState();
      return false;
    }
  }

  async persist(): Promise<void> {
    await this.fileMutex.runExclusive(async () => {
      await this.writeAtomic(JSON.stringify(this.data, null, 2));
    });
  }

  async saveRecord(id: string, record: StateRecord): Promise<void> {
    await this.fileMutex.runExclusive(async () => {
      this.data.records[id] = record;
      if (record.shortId) this.data.byShortId[record.shortId] = id;
      await this.writeAtomic(JSON.stringify(this.data, null, 2));
    });
  }

  async markDeleted(id: string, row: number): Promise<void> {
    await this.fileMutex.runExclusive(async () => {
      const current = this.data.records[id];
      if (!current) return;
      current.status = "DELETED";
      current.row = row;
      current.updatedAt = new Date().toISOString();
      await this.writeAtomic(JSON.stringify(this.data, null, 2));
    });
  }

  async addNotes(id: string, notes: Note[]): Promise<void> {
    if (notes.length === 0) return;
    await this.fileMutex.runExclusive(async () => {
      const current = this.data.records[id];
      if (!current) return;
      for (const note of notes) {
        if (!current.notes.includes(note)) current.notes.push(note);
      }
      await this.writeAtomic(JSON.stringify(this.data, null, 2));
    });
  }

  async setLastSync(timestamp: number): Promise<void> {
    await this.fileMutex.runExclusive(async () => {
      if (timestamp <= this.data.last_sync_timestamp) return;
      this.data.last_sync_timestamp = timestamp;
      await this.writeAtomic(JSON.stringify(this.data, null, 2));
    });
  }

  private async writeAtomic(payload: string): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, payload, "utf8");
    try {
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EEXIST") {
        await fs.rm(this.filePath, { force: true });
        await fs.rename(tmp, this.filePath);
        return;
      }
      throw error;
    }
  }
}
