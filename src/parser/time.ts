export interface ClockPoint {
  hhmm: string;
  minutes: number;
}

interface Readings {
  /** True when am/pm was written, or the hour is already 13–23. */
  explicit: boolean;
  options: ClockPoint[];
}

export interface ShiftInput {
  start?: string;
  pause?: string;
  resume?: string;
  finish?: string;
}

export interface ShiftResolution {
  start: string;
  pause: string;
  resume: string;
  finish: string;
  startMinute: number | null;
  endMinute: number | null;
  calculatedHours: number | null;
  ambiguous: boolean;
  incompleteBreak: boolean;
}

const SIXTEEN_HOURS = 16 * 60;

function point(hour: number, minute: number): ClockPoint {
  const minutes = hour * 60 + minute;
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return { hhmm: `${hh}:${mm}`, minutes };
}

/** Parse one clock token. `6.53` is 6:53, not 6.53 decimal hours. Returns null when the token is not a clock. */
export function parseClockToken(raw: string): Readings | null {
  const match = raw.trim().match(/^(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isInteger(minute) || minute > 59) return null;
  let hour = Number(match[1]);
  if (!Number.isInteger(hour) || hour > 23) return null;
  const meridiem = match[3]?.toLowerCase();

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
    return { explicit: true, options: [point(hour, minute)] };
  }

  if (hour >= 13) return { explicit: true, options: [point(hour, minute)] };

  const options = [point(hour, minute)];
  if (hour >= 1 && hour <= 11) options.push(point(hour + 12, minute));
  return { explicit: false, options };
}

function choose(
  readings: Readings,
  previous: number | null,
  isStart: boolean,
): ClockPoint | null {
  const fitsAfter = (option: ClockPoint): boolean =>
    previous === null ||
    (option.minutes > previous && option.minutes - previous <= SIXTEEN_HOURS);

  if (readings.explicit) {
    const only = readings.options[0];
    if (!only) return null;
    if (!isStart && !fitsAfter(only)) return null;
    return only;
  }

  if (isStart || previous === null) {
    return (
      readings.options.find(
        (option) => option.minutes >= 5 * 60 && option.minutes <= 11 * 60 + 59,
      ) ?? null
    );
  }

  const fits = readings.options.filter(fitsAfter);
  fits.sort((a, b) => a.minutes - b.minutes);
  return fits[0] ?? null;
}

export function roundHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

/**
 * Resolve start, pause, resume, and finish in that order.
 * A bare start hour in 05:00–11:59 stays in the morning (`6.53` → `06:53`).
 * A later bare hour uses the reading that continues the shift (`5.04` after 14:38 → `17:04`).
 */
export function resolveShift(input: ShiftInput): ShiftResolution {
  const provided = {
    start: input.start?.trim() ?? "",
    pause: input.pause?.trim() ?? "",
    resume: input.resume?.trim() ?? "",
    finish: input.finish?.trim() ?? "",
  };
  const resolved: Record<"start" | "pause" | "resume" | "finish", ClockPoint | null> = {
    start: null,
    pause: null,
    resume: null,
    finish: null,
  };
  let ambiguous = false;
  let previous: number | null = null;

  const order: Array<"start" | "pause" | "resume" | "finish"> = [
    "start",
    "pause",
    "resume",
    "finish",
  ];
  for (const key of order) {
    const raw = provided[key];
    if (!raw) continue;
    const readings = parseClockToken(raw);
    const chosen: ClockPoint | null = readings
      ? choose(readings, previous, key === "start")
      : null;
    if (!chosen) {
      ambiguous = true;
      continue;
    }
    resolved[key] = chosen;
    previous = chosen.minutes;
  }

  const pauseGiven = provided.pause.length > 0;
  const resumeGiven = provided.resume.length > 0;
  const incompleteBreak = pauseGiven !== resumeGiven;

  let calculatedHours: number | null = null;
  const start = resolved.start;
  const finish = resolved.finish;
  if (!ambiguous && start && finish) {
    if (pauseGiven && resumeGiven && resolved.pause && resolved.resume) {
      const morning = resolved.pause.minutes - start.minutes;
      const afternoon = finish.minutes - resolved.resume.minutes;
      if (morning >= 0 && afternoon >= 0) calculatedHours = roundHours(morning + afternoon);
      else ambiguous = true;
    } else if (!pauseGiven && !resumeGiven) {
      if (finish.minutes > start.minutes) {
        calculatedHours = roundHours(finish.minutes - start.minutes);
      } else {
        ambiguous = true;
      }
    } else if (incompleteBreak && finish.minutes > start.minutes) {
      calculatedHours = roundHours(finish.minutes - start.minutes);
    }
  }

  return {
    start: resolved.start?.hhmm ?? "",
    pause: resolved.pause?.hhmm ?? "",
    resume: resolved.resume?.hhmm ?? "",
    finish: resolved.finish?.hhmm ?? "",
    startMinute: resolved.start?.minutes ?? null,
    endMinute: resolved.finish?.minutes ?? null,
    calculatedHours: ambiguous ? null : calculatedHours,
    ambiguous,
    incompleteBreak,
  };
}

function formatDutyDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** Day, then month, then year. `20.10.26` is 20 October 2026. Two-digit years 00–69 map to 2000–2069. ISO `YYYY-MM-DD` is also accepted. */
export function parseDutyDate(raw: string): string | null {
  const iso = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso?.[1] && iso[2] && iso[3]) {
    return formatDutyDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const match = raw.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (match[3].length === 2) year = year <= 69 ? 2000 + year : 1900 + year;
  return formatDutyDate(year, month, day);
}

export function normalizeStaff(raw: string): string {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(", ");
}

export function staffNames(technicians: string, associates: string): string[] {
  return `${technicians},${associates}`
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}
