import { createHash, randomBytes } from "node:crypto";
import { tokensMatch } from "./token.ts";

const TTL_MS = 60_000;
const CAPACITY = 32;
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class InstallCodeCapacityError extends Error {
  constructor() {
    super("install link capacity reached");
  }
}

/** Ephemeral authority: no codes, tokens or entries are enumerable or persisted. */
export class InstallCodes {
  #token: string;
  #port: number;
  #now: () => number;
  #lastNow = -Infinity;
  #entries = new Map<string, { expiresAt: number; used: boolean }>();

  constructor(token: string, port: number, now: () => number = Date.now) {
    this.#token = token;
    this.#port = port;
    this.#now = now;
  }

  belongsTo(token: string, port: number): boolean {
    return port === this.#port && tokensMatch(this.#token, token);
  }

  issue(): { code: string; expiresAt: number } {
    const now = this.#prune();
    if (this.#entries.size >= CAPACITY) throw new InstallCodeCapacityError();
    let code: string;
    let digest: string;
    do {
      code = randomBytes(32).toString("base64url");
      digest = hash(code);
    } while (this.#entries.has(digest) || tokensMatch(code, this.#token));
    const expiresAt = now + TTL_MS;
    this.#entries.set(digest, { expiresAt, used: false });
    return { code, expiresAt };
  }

  consume(code: string): string | undefined {
    this.#prune();
    if (!CODE_PATTERN.test(code)) return undefined;
    const entry = this.#entries.get(hash(code));
    if (!entry || entry.used) return undefined;
    // This synchronous transition precedes returning authority, including concurrent requests.
    entry.used = true;
    return this.#token;
  }

  #prune(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now)) {
      this.#entries.clear();
      throw new Error("invalid install link clock");
    }
    if (now < this.#lastNow) this.#entries.clear();
    this.#lastNow = now;
    for (const [digest, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(digest);
    }
    return now;
  }
}

function hash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
