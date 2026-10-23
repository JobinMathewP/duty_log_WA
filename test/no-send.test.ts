import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("read-only whatsapp client", () => {
  it("never references send paths", () => {
    const files = walk(path.resolve("src"));
    expect(files.length).toBeGreaterThan(0);
    const banned = ["sendMessage", "sendSeen"];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const word of banned) {
        expect(text.includes(word), `${file} contains ${word}`).toBe(false);
      }
    }
  });
});
