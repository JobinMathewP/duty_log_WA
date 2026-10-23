import type { ExtractedFields } from "./types.js";

const line = String.raw`^[^\S\r\n]*`;

const sitePattern = new RegExp(line + String.raw`site\s*[:\-]\s*(.+?)\s*,?\s*$`, "im");
const datePattern = new RegExp(
  line + String.raw`date\s*[:\-]\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s*$`,
  "im",
);
const hoursPattern = new RegExp(
  line + String.raw`total(?:\s*working)?\s*hrs?\s*[:\-]\s*(\d+(?:\.\d+)?)`,
  "im",
);
const techniciansPattern = new RegExp(
  line + String.raw`(?<!associate\s)technicians?\s*[:\-]\s*(.+)\s*$`,
  "im",
);
const associatesPattern = new RegExp(
  line + String.raw`associate\s*technicians?\s*[:\-]\s*(.+)\s*$`,
  "im",
);
const headingPattern =
  /^\s*([A-Za-z][A-Za-z .'-]*?)\.?\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*$/im;
const siteLinePattern = new RegExp(line + String.raw`site\s*[:\-]`, "gim");

function clockPattern(label: string): RegExp {
  return new RegExp(
    line + label + String.raw`\s*[:\-]\s*(\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm)?)\s*$`,
    "im",
  );
}

const startPattern = clockPattern(String.raw`start\s*duty`);
const pausePattern = clockPattern(String.raw`pause\s*duty`);
const resumePattern = clockPattern(String.raw`resume\s*duty`);
const finishPattern = clockPattern(String.raw`finish\s*duty`);

function field(pattern: RegExp, body: string): string {
  const match = pattern.exec(body);
  return match?.[1]?.trim() ?? "";
}

export function extractFields(body: string): ExtractedFields {
  const heading = headingPattern.exec(body);
  const reportedRaw = field(hoursPattern, body);
  const reported = reportedRaw.length > 0 ? Number(reportedRaw) : null;
  return {
    logName: heading?.[1]?.trim() ?? "",
    weekday: heading?.[2] ?? "",
    site: field(sitePattern, body),
    dutyDateRaw: field(datePattern, body),
    startRaw: field(startPattern, body),
    pauseRaw: field(pausePattern, body),
    resumeRaw: field(resumePattern, body),
    finishRaw: field(finishPattern, body),
    reportedHours: reported !== null && Number.isFinite(reported) ? reported : null,
    technicians: field(techniciansPattern, body),
    associates: field(associatesPattern, body),
    multipleLogs: (body.match(siteLinePattern) ?? []).length > 1,
  };
}
