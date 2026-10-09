import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { PrivateFiles } from "../agent/private-files.ts";

// Reads a result file's stored bytes with no-follow descriptors, as downloads do.
export class StoredFiles {
  readonly #files: PrivateFiles;
  constructor(home: string) {
    this.#files = new PrivateFiles(home);
  }
  exists(rel: string): boolean {
    try {
      return lstatSync(this.#files.path(rel), { throwIfNoEntry: false })?.isFile() === true;
    } catch {
      return false;
    }
  }
  // The first `max` bytes and the full size, or undefined when the file is missing.
  head(rel: string, max: number): { head: Buffer; size: number } | undefined {
    let path: string;
    try {
      path = this.#files.path(rel);
    } catch {
      return undefined;
    }
    const before = lstatSync(path, { throwIfNoEntry: false });
    if (!before?.isFile()) return undefined;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev) return undefined;
      const head = Buffer.allocUnsafe(Math.min(max, st.size));
      let read = 0;
      while (read < head.length) {
        const n = readSync(fd, head, read, head.length - read, read);
        if (n === 0) break;
        read += n;
      }
      return { head: head.subarray(0, read), size: st.size };
    } finally {
      closeSync(fd);
    }
  }
  path(rel: string): string {
    return this.#files.path(rel);
  }
  directory(rel: string): string {
    return this.#files.directory(rel);
  }
}
