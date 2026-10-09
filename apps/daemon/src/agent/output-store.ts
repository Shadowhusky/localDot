import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { MAX_OUTPUT_VERSION, ULID_PATTERN } from "@localdot/protocol";
import { PrivateFiles } from "./private-files.ts";
export const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
export interface OutputScope {
  signal: AbortSignal;
  check(): void;
}
export interface SavedOutput {
  path: string;
  bytes: number;
  version: number;
}
interface Slot {
  out: string;
  dir: string;
  name: string;
  target: string;
  before: Stats | undefined;
  tmp: string;
}
const VERSION = /^[1-9]\d{0,4}$/;
export function outputNameProblem(name: string): boolean {
  return !name || name.length > 200 || !/^[-\w. ]+$/.test(name) || name === "." || name === "..";
}
// Where a result file's bytes live, relative to the home: a numbered version, or out/<name> (the
// newest version, and the only copy of a result saved before versions existed).
export function outputPath(
  sessionId: string,
  name: string,
  version: number | null,
): string | undefined {
  if (!ULID_PATTERN.test(sessionId) || outputNameProblem(name)) return undefined;
  if (version === null) return `sessions/${sessionId}/out/${name}`;
  return Number.isSafeInteger(version) && version >= 1 && version <= MAX_OUTPUT_VERSION
    ? `sessions/${sessionId}/versions/${name}/${version}`
    : undefined;
}
// Atomic private output. Every version is kept at sessions/<id>/versions/<name>/<n>, and
// sessions/<id>/out/<name> is a second link to the newest one, so downloads by name keep working.
// The application-owned ancestor limitation matches PrivateFiles.
export class OutputStore {
  readonly #files: PrivateFiles;
  constructor(
    home: string,
    private readonly maxBytes = MAX_OUTPUT_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTPUT_BYTES)
      throw new Error("invalid output limit");
    this.#files = new PrivateFiles(home);
  }
  async save(
    sessionId: string,
    name: string,
    source: ReadableStream<Uint8Array>,
    scope: OutputScope,
  ): Promise<SavedOutput> {
    const check = () => {
      scope.signal.throwIfAborted();
      scope.check();
    };
    check();
    const slot = this.#slot(sessionId, name);
    let fd: number | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bytes = 0;
    try {
      check();
      fd = this.#openTemp(slot.tmp);
      reader = source.getReader();
      const cancel = () => {
        void reader?.cancel(scope.signal.reason).catch(() => {});
      };
      scope.signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          check();
          const part = await reader.read();
          check();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > this.maxBytes) throw new Error("output exceeds the 100 MiB limit");
          this.#write(fd, part.value, check);
        }
      } finally {
        scope.signal.removeEventListener("abort", cancel);
      }
      check();
      closeSync(fd);
      fd = undefined;
      return this.#commit(slot, bytes, check);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(slot.tmp, { force: true });
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
  // Small outputs from fixtures and tests take the same publication path as streamed ones.
  saveBytes(sessionId: string, name: string, data: Uint8Array): SavedOutput {
    if (data.byteLength > this.maxBytes) throw new Error("output exceeds the 100 MiB limit");
    const slot = this.#slot(sessionId, name);
    let fd: number | undefined;
    try {
      fd = this.#openTemp(slot.tmp);
      this.#write(fd, data, () => {});
      closeSync(fd);
      fd = undefined;
      return this.#commit(slot, data.byteLength, () => {});
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(slot.tmp, { force: true });
    }
  }
  #slot(sessionId: string, name: string): Slot {
    if (!ULID_PATTERN.test(sessionId) || outputNameProblem(name))
      throw new Error("invalid output name");
    const out = `sessions/${sessionId}/out`;
    this.#files.directory(out);
    const target = this.#files.path(`${out}/${name}`);
    const before = lstatSync(target, { throwIfNoEntry: false });
    if (before && !before.isFile()) throw new Error("output must be a regular file");
    const dir = `sessions/${sessionId}/versions/${name}`;
    this.#files.directory(dir);
    const tmp = this.#files.path(`${dir}/.${randomBytes(12).toString("hex")}.partial`);
    return { out, dir, name, target, before, tmp };
  }
  #openTemp(tmp: string): number {
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      throw new Error("invalid output file");
    }
    return fd;
  }
  #write(fd: number, data: Uint8Array, check: () => void): void {
    for (let offset = 0; offset < data.byteLength; ) {
      check();
      const n = writeSync(fd, data, offset, data.byteLength - offset);
      if (n <= 0) throw new Error("output write made no progress");
      offset += n;
    }
  }
  #commit(slot: Slot, bytes: number, check: () => void): SavedOutput {
    this.#files.path(`${slot.out}/${slot.name}`);
    const now = lstatSync(slot.target, { throwIfNoEntry: false });
    if (
      slot.before
        ? !now?.isFile() || now.dev !== slot.before.dev || now.ino !== slot.before.ino
        : now !== undefined
    )
      throw new Error("output target changed");
    check();
    const version = this.#publish(slot.dir, slot.tmp);
    const link = this.#files.path(
      `${slot.out}/.${slot.name}.${randomBytes(12).toString("hex")}.link`,
    );
    try {
      linkSync(this.#files.path(`${slot.dir}/${version}`), link);
      renameSync(link, slot.target);
    } finally {
      rmSync(link, { force: true });
    }
    return { path: slot.target, bytes, version };
  }
  // A version number is never reused: the hard link refuses one that already exists.
  #publish(dir: string, tmp: string): number {
    for (let attempt = 0; attempt < 8; attempt++) {
      const path = this.#files.path(dir);
      const next =
        Math.max(
          0,
          ...readdirSync(path)
            .filter((entry) => VERSION.test(entry))
            .map(Number),
        ) + 1;
      if (next > MAX_OUTPUT_VERSION) throw new Error("too many versions of this output");
      try {
        linkSync(tmp, this.#files.path(`${dir}/${next}`));
        return next;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("output version is busy");
  }
}
