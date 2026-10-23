import { isDutyCandidate } from "./candidate.js";
import { askGemini } from "./gemini.js";
import { buildRecord, isClean } from "./record.js";
import { extractFields } from "./regex.js";
import type { DutyLogRecord, ExtractedFields, ParseOptions } from "./types.js";

function geminiFields(partial: ExtractedFields, filled: ExtractedFields): ExtractedFields {
  const pick = (current: string, next: string): string => (current.length > 0 ? current : next);
  return {
    logName: pick(partial.logName, filled.logName),
    weekday: pick(partial.weekday, filled.weekday),
    site: pick(partial.site, filled.site),
    dutyDateRaw: pick(partial.dutyDateRaw, filled.dutyDateRaw),
    startRaw: pick(partial.startRaw, filled.startRaw),
    pauseRaw: pick(partial.pauseRaw, filled.pauseRaw),
    resumeRaw: pick(partial.resumeRaw, filled.resumeRaw),
    finishRaw: pick(partial.finishRaw, filled.finishRaw),
    reportedHours: partial.reportedHours ?? filled.reportedHours,
    technicians: pick(partial.technicians, filled.technicians),
    associates: pick(partial.associates, filled.associates),
    multipleLogs: partial.multipleLogs,
  };
}

/**
 * Regex first. Gemini runs only for a duty-log candidate that is still missing
 * site, duty date, start, or finish. A non-candidate returns null and is not stored.
 */
export async function parseMessage(
  body: string,
  options: ParseOptions,
): Promise<DutyLogRecord | null> {
  if (!isDutyCandidate(body)) return null;
  const extracted = extractFields(body);
  const local = buildRecord(extracted, body, "REGEX", options.hoursMismatchThreshold);
  if (isClean(local)) return local;

  const aiReady =
    options.enableAiFallback &&
    options.geminiApiKey.length > 0 &&
    !extracted.multipleLogs;
  if (!aiReady) return local;

  const guessed = await askGemini(body, options.geminiApiKey, options.geminiModel);
  if (!guessed) return local;
  const merged = buildRecord(
    geminiFields(extracted, guessed),
    body,
    "GEMINI",
    options.hoursMismatchThreshold,
  );
  return isClean(merged) ? merged : local;
}
