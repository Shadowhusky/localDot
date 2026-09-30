import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const MIN_TOKEN_LENGTH = 32;

export function loadOrCreateToken(file: string): string {
  const existing = readValidToken(file);
  if (existing !== undefined) return existing;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${token}\n`, { mode: 0o600, flag: "wx" });
  try {
    if (linkIfAbsent(temp, file)) return token;
    const raced = readValidToken(file);
    if (raced !== undefined) return raced;
    renameSync(temp, file);
    return token;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function tokensMatch(expected: string, given: string | undefined): boolean {
  if (expected.length === 0 || given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readValidToken(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const token = readFileSync(file, "utf8").trim();
  if (token.length < MIN_TOKEN_LENGTH) return undefined;
  chmodSync(file, 0o600);
  return token;
}

function linkIfAbsent(temp: string, file: string): boolean {
  try {
    linkSync(temp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
