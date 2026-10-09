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
  // An open descriptor on the file and its size, or undefined when it is missing or not a regular
  // file. The caller closes it.
  open(rel: string): { fd: number; size: number } | undefined {
    let path: string;
    try {
      path = this.#files.path(rel);
    } catch {
      return undefined;
    }
    const before = lstatSync(path, { throwIfNoEntry: false });
    if (!before?.isFile()) return undefined;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev) {
      closeSync(fd);
      return undefined;
    }
    return { fd, size: st.size };
  }
  // The first `max` bytes and the full size, or undefined when the file is missing.
  head(rel: string, max: number): { head: Buffer; size: number } | undefined {
    return this.#read(rel, max, false);
  }
  // The last `max` bytes and the full size.
  tail(rel: string, max: number): { tail: Buffer; size: number } | undefined {
    const read = this.#read(rel, max, true);
    return read && { tail: read.head, size: read.size };
  }
  path(rel: string): string {
    return this.#files.path(rel);
  }
  directory(rel: string): string {
    return this.#files.directory(rel);
  }
  #read(rel: string, max: number, end: boolean): { head: Buffer; size: number } | undefined {
    const opened = this.open(rel);
    if (!opened) return undefined;
    const { fd, size } = opened;
    try {
      const head = Buffer.allocUnsafe(Math.min(max, size));
      const start = end ? size - head.length : 0;
      let read = 0;
      while (read < head.length) {
        const n = readSync(fd, head, read, head.length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      return { head: head.subarray(0, read), size };
    } finally {
      closeSync(fd);
    }
  }
}
