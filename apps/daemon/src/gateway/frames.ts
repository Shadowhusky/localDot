import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ULID_PATTERN } from "@localdot/protocol";

const DIGESTS_KEPT = 256;
const FULL = ".full";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// observe screenshots live beside the session log, keyed by frameId, never inline in the JSONL.
export class FrameStore {
  readonly #root: string;
  // The newest frames' digests, taken as they are saved.
  readonly #digests = new Map<string, string>();

  constructor(home: string) {
    this.#root = join(home, "sessions");
  }

  save(sessionId: string, frameId: string, bytes: Buffer): string {
    const file = this.#file(sessionId, frameId);
    this.#digests.set(file, sha256(bytes));
    if (this.#digests.size > DIGESTS_KEPT) {
      const [oldest] = this.#digests.keys();
      if (oldest !== undefined) this.#digests.delete(oldest);
    }
    return this.#write(sessionId, file, bytes);
  }

  // The same moment at the screen's device resolution, for people to look at: the model reads
  // only the frame save() keeps.
  saveFull(sessionId: string, frameId: string, bytes: Buffer): string {
    return this.#write(sessionId, this.#file(sessionId, frameId, FULL), bytes);
  }

  fullPath(sessionId: string, frameId: string): string | undefined {
    if (!ULID_PATTERN.test(sessionId) || !ULID_PATTERN.test(frameId)) return undefined;
    const file = this.#file(sessionId, frameId, FULL);
    return existsSync(file) ? file : undefined;
  }

  #write(sessionId: string, file: string, bytes: Buffer): string {
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

  // A stored frame's content digest; undefined when there is no such frame.
  digest(sessionId: string, frameId: string): string | undefined {
    const file = this.path(sessionId, frameId);
    if (!file) return undefined;
    return this.#digests.get(file) ?? sha256(readFileSync(file));
  }

  path(sessionId: string, frameId: string): string | undefined {
    if (!ULID_PATTERN.test(sessionId) || !ULID_PATTERN.test(frameId)) return undefined;
    const file = this.#file(sessionId, frameId);
    return existsSync(file) ? file : undefined;
  }

  #file(sessionId: string, frameId: string, suffix = ""): string {
    if (!ULID_PATTERN.test(sessionId) || !ULID_PATTERN.test(frameId))
      throw new RangeError("invalid session or frame id");
    return join(this.#root, sessionId, "frames", `${frameId}${suffix}.webp`);
  }
}
