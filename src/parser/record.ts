import { normalizeStaff, parseDutyDate, resolveShift } from "./time.js";
import type { DutyLogRecord, ExtractedFields, Note } from "./types.js";

export function isClean(
  record: Pick<DutyLogRecord, "site" | "dutyDate" | "start" | "finish" | "multipleLogs">,
): boolean {
  return (
    !record.multipleLogs &&
    record.site.length > 0 &&
    record.dutyDate.length > 0 &&
    record.start.length > 0 &&
    record.finish.length > 0
  );
}

export function countableHours(
  status: DutyLogRecord["status"],
  reported: number | null,
  calculated: number | null,
): number {
  if (status === "DELETED") return 0;
  if (status === "NEEDS_REVIEW") return reported ?? 0;
  return reported ?? calculated ?? 0;
}

/** Turn extracted label text into a sheet record. Clock tokens still pass through the shift resolver. */
export function buildRecord(
  fields: ExtractedFields,
  raw: string,
  parser: DutyLogRecord["parser"],
  hoursMismatchThreshold: number,
): DutyLogRecord {
  const shift = resolveShift({
    start: fields.startRaw,
    pause: fields.pauseRaw,
    resume: fields.resumeRaw,
    finish: fields.finishRaw,
  });
  const dutyDate = fields.dutyDateRaw ? (parseDutyDate(fields.dutyDateRaw) ?? "") : "";
  const draft: DutyLogRecord = {
    status: "ACTIVE",
    logName: fields.logName,
    weekday: fields.weekday,
    site: fields.site,
    dutyDate,
    start: shift.start,
    pause: shift.pause,
    resume: shift.resume,
    finish: shift.finish,
    reportedHours: fields.reportedHours,
    calculatedHours: shift.calculatedHours,
    countableHours: 0,
    technicians: normalizeStaff(fields.technicians),
    associates: normalizeStaff(fields.associates),
    notes: [],
    parser,
    raw,
    startMinute: shift.startMinute,
    endMinute: shift.endMinute,
    multipleLogs: fields.multipleLogs,
  };

  const notes: Note[] = [];
  if (shift.ambiguous) notes.push("AMBIGUOUS_TIME");
  if (shift.incompleteBreak) notes.push("INCOMPLETE_BREAK");
  const clean = isClean(draft);
  if (fields.reportedHours === null && clean) notes.push("MISSING_REPORTED");
  if (
    fields.reportedHours !== null &&
    shift.calculatedHours !== null &&
    Math.abs(fields.reportedHours - shift.calculatedHours) > hoursMismatchThreshold
  ) {
    notes.push("HOURS_MISMATCH");
  }

  const status = clean ? "ACTIVE" : "NEEDS_REVIEW";
  return {
    ...draft,
    status,
    notes,
    countableHours: countableHours(status, fields.reportedHours, shift.calculatedHours),
  };
}
