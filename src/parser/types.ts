export type Status = "ACTIVE" | "EDITED" | "DELETED" | "NEEDS_REVIEW";

export type ParserKind = "REGEX" | "GEMINI";

export type Note =
  | "HOURS_MISMATCH"
  | "AMBIGUOUS_TIME"
  | "INCOMPLETE_BREAK"
  | "MISSING_REPORTED"
  | "POSSIBLE_DUPLICATE"
  | "OVERLAP"
  | "FORWARDED";

const NOTE_VALUES: readonly Note[] = [
  "HOURS_MISMATCH",
  "AMBIGUOUS_TIME",
  "INCOMPLETE_BREAK",
  "MISSING_REPORTED",
  "POSSIBLE_DUPLICATE",
  "OVERLAP",
  "FORWARDED",
];

export function isNote(value: string): value is Note {
  return (NOTE_VALUES as readonly string[]).includes(value);
}

export interface DutyLogRecord {
  status: Status;
  logName: string;
  weekday: string;
  site: string;
  dutyDate: string;
  start: string;
  pause: string;
  resume: string;
  finish: string;
  reportedHours: number | null;
  calculatedHours: number | null;
  countableHours: number;
  technicians: string;
  associates: string;
  notes: Note[];
  parser: ParserKind | "";
  raw: string;
  startMinute: number | null;
  endMinute: number | null;
  multipleLogs: boolean;
}

export interface ExtractedFields {
  logName: string;
  weekday: string;
  site: string;
  dutyDateRaw: string;
  startRaw: string;
  pauseRaw: string;
  resumeRaw: string;
  finishRaw: string;
  reportedHours: number | null;
  technicians: string;
  associates: string;
  multipleLogs: boolean;
}

export interface ParseOptions {
  hoursMismatchThreshold: number;
  enableAiFallback: boolean;
  geminiApiKey: string;
  geminiModel: string;
}
