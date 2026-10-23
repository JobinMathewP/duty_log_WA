import fs from "node:fs/promises";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
  appendFailed(raw: string, reason: string): Promise<void>;
}

export function createLogger(level: LogLevel, failedLogPath = "./data/failed_messages.log"): Logger {
  const write = (current: LogLevel, message: string, extra?: unknown): void => {
    if (rank[current] < rank[level]) return;
    const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
    const line = `[${current}] ${message}${suffix}`;
    if (current === "error") console.error(line);
    else console.log(line);
  };

  return {
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
    async appendFailed(raw, reason) {
      await fs.mkdir(path.dirname(failedLogPath), { recursive: true });
      const block = `\n--- ${new Date().toISOString()} ${reason}\n${raw}\n`;
      await fs.appendFile(failedLogPath, block, "utf8");
    },
  };
}
