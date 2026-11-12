// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { messagesIn } from "./messages.ts";
import { PARTS, zhCN } from "./zh-CN/index.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const SKIP = /(\.test\.tsx?$|\.d\.ts$|\/testing\/|\/_spike\/|\/gallery\/|\/i18n\/)/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !SKIP.test(path) ? [path] : [];
  });
}

const asked = new Map<string, string>();
for (const file of sources(SRC))
  for (const message of messagesIn(readFileSync(file, "utf8")))
    if (!asked.has(message)) asked.set(message, relative(SRC, file));

const values = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(([value]) => value).sort();

describe("the Simplified Chinese catalog", () => {
  it("translates every message the app asks for", () => {
    const missing = [...asked]
      .filter(([key]) => !(key in zhCN))
      .map(([key, file]) => `${file}: ${key}`);
    expect(missing, "Add these to apps/web/src/i18n/zh-CN").toEqual([]);
  });

  it("keeps every value a message has, and a count's number", () => {
    const wrong = Object.entries(zhCN).filter(([key, text]) => {
      if (!text.trim()) return true;
      if (key.includes("|") && /^[^{}|]+\|[^{}|]+$/.test(key)) return !text.includes("#");
      return values(key).join() !== values(text).join();
    });
    expect(wrong.map(([key]) => key)).toEqual([]);
  });

  it("keeps each message in one file", () => {
    const where = new Map<string, string[]>();
    for (const [part, entries] of Object.entries(PARTS))
      for (const key of Object.keys(entries)) where.set(key, [...(where.get(key) ?? []), part]);
    const twice = [...where].filter(([, parts]) => parts.length > 1);
    expect(twice.map(([key, parts]) => `${key}: ${parts.join(", ")}`)).toEqual([]);
  });

  it("holds nothing the app no longer asks for", () => {
    expect(Object.keys(zhCN).filter((key) => !asked.has(key))).toEqual([]);
  });
});
