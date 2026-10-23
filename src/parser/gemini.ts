import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import type { ExtractedFields } from "./types.js";

/** Gemini 3 rejects thinkingBudget. MINIMAL is the smallest level these models accept. */
const thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };

const schema = {
  type: Type.OBJECT,
  properties: {
    logName: { type: Type.STRING },
    weekday: { type: Type.STRING },
    site: { type: Type.STRING },
    dutyDate: { type: Type.STRING },
    start: { type: Type.STRING },
    pause: { type: Type.STRING },
    resume: { type: Type.STRING },
    finish: { type: Type.STRING },
    reportedHours: { type: Type.NUMBER, nullable: true },
    technicians: { type: Type.STRING },
    associates: { type: Type.STRING },
  },
  required: ["site", "dutyDate", "start", "finish"],
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hours(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Ask Gemini for the labeled fields only. Returned clocks and dates are raw tokens;
 * the caller runs them through the same resolver as the regex tier.
 * Returns null on any failure so the row can still be stored as NEEDS_REVIEW.
 */
export async function askGemini(
  body: string,
  apiKey: string,
  model: string,
): Promise<ExtractedFields | null> {
  const contents = [
    "Extract one WhatsApp duty log. Dates are day.month.year (20.10.26 means 20 October 2026).",
    "Clock times use a dot or a colon as HH:mm. 6.53 with no am/pm is 06:53 in the morning, not decimal hours.",
    "Leave a string empty when the line is missing. Do not invent a date from outside the message.",
    "technicians and associates are comma-separated names.",
    "",
    body,
  ].join("\n");
  console.log(`[gemini] sending to ${model}\n${contents}`);
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        thinkingConfig,
      },
    });
    const raw = response.text;
    console.log(`[gemini] reply\n${raw ?? "(empty)"}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      logName: text(record.logName),
      weekday: text(record.weekday),
      site: text(record.site),
      dutyDateRaw: text(record.dutyDate),
      startRaw: text(record.start),
      pauseRaw: text(record.pause),
      resumeRaw: text(record.resume),
      finishRaw: text(record.finish),
      reportedHours: hours(record.reportedHours),
      technicians: text(record.technicians),
      associates: text(record.associates),
      multipleLogs: false,
    };
  } catch (error) {
    console.log(`[gemini] error ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** One tiny structured call so `npm run check` can prove the key and model respond. */
export async function pingGemini(apiKey: string, model: string): Promise<void> {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: 'Reply with the JSON object {"ok":true}',
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: { ok: { type: Type.BOOLEAN } },
        required: ["ok"],
      },
      thinkingConfig,
    },
  });
  if (!response.text) throw new Error("empty gemini response");
}
