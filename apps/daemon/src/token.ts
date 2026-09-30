import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MIN_TOKEN_LENGTH = 32;

export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= MIN_TOKEN_LENGTH) {
      chmodSync(file, 0o600);
      return existing;
    }
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${token}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
  return token;
}

export function tokensMatch(expected: string, given: string | undefined): boolean {
  if (expected.length === 0 || given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
