import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { ULID_PATTERN } from "@localdot/protocol";
import { PrivateFiles } from "./private-files.ts";
export const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
export interface OutputScope {
  signal: AbortSignal;
  check(): void;
}
// Atomic private output. The application-owned ancestor limitation matches PrivateFiles.
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
  ): Promise<{ path: string; bytes: number }> {
    const check = () => {
      scope.signal.throwIfAborted();
      scope.check();
    };
    check();
    if (
      !ULID_PATTERN.test(sessionId) ||
      !name ||
      name.length > 200 ||
      !/^[-\w. ]+$/.test(name) ||
      name === "." ||
      name === ".."
    )
      throw new Error("invalid output name");
    const rel = `sessions/${sessionId}/out`;
    this.#files.directory(rel);
    check();
    const target = this.#files.path(`${rel}/${name}`);
    const before = lstatSync(target, { throwIfNoEntry: false });
    if (before && !before.isFile()) throw new Error("output must be a regular file");
    const tmp = this.#files.path(`${rel}/.${name}.${randomBytes(12).toString("hex")}.partial`);
    let fd: number | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bytes = 0;
    try {
      check();
      fd = openSync(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(fd, 0o600);
      if (!fstatSync(fd).isFile()) throw new Error("invalid output file");
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
          for (let offset = 0; offset < part.value.byteLength; ) {
            check();
            const n = writeSync(fd, part.value, offset, part.value.byteLength - offset);
            if (n <= 0) throw new Error("output write made no progress");
            offset += n;
          }
        }
      } finally {
        scope.signal.removeEventListener("abort", cancel);
      }
      check();
      closeSync(fd);
      fd = undefined;
      this.#files.path(`${rel}/${name}`);
      const now = lstatSync(target, { throwIfNoEntry: false });
      if (
        before
          ? !now?.isFile() || now.dev !== before.dev || now.ino !== before.ino
          : now !== undefined
      )
        throw new Error("output target changed");
      check();
      renameSync(tmp, target);
      return { path: target, bytes };
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(tmp, { force: true });
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
}
