import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ULID_PATTERN } from "@localdot/protocol";

// observe screenshots live beside the session log, keyed by frameId, never inline in the JSONL.
export class FrameStore {
  readonly #root: string;

  constructor(home: string) {
    this.#root = join(home, "sessions");
  }

  save(sessionId: string, frameId: string, bytes: Buffer): string {
    const file = this.#file(sessionId, frameId);
    mkdirSync(join(this.#root, sessionId, "frames"), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
    try {
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    return file;
  }

  path(sessionId: string, frameId: string): string | undefined {
    if (!ULID_PATTERN.test(sessionId) || !ULID_PATTERN.test(frameId)) return undefined;
    const file = this.#file(sessionId, frameId);
    return existsSync(file) ? file : undefined;
  }

  #file(sessionId: string, frameId: string): string {
    if (!ULID_PATTERN.test(sessionId) || !ULID_PATTERN.test(frameId))
      throw new RangeError("invalid session or frame id");
    return join(this.#root, sessionId, "frames", `${frameId}.webp`);
  }
}
