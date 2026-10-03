import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

// Private application-owned storage. Final files use no-follow descriptors; ancestor checks do
// not constitute openat confinement against concurrent malicious writes by the same host UID.
export class PrivateFiles {
  readonly root: string;
  constructor(home: string, subdir?: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (!lstatSync(home).isDirectory()) throw new Error("application home must be a directory");
    this.root = realpathSync(home);
    if (subdir) this.root = this.directory(subdir);
  }
  path(rel: string): string {
    const parts = rel.split("/");
    if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\0") || p.includes("\\")))
      throw new Error("invalid storage path");
    const path = join(this.root, ...parts);
    if (resolve(path) === this.root) throw new Error("invalid storage path");
    this.#parents(dirname(path));
    return path;
  }
  #parents(dir: string): void {
    let current = this.root;
    if (!lstatSync(current).isDirectory()) throw new Error("private directory changed");
    for (const part of dir.slice(this.root.length).split("/").filter(Boolean)) {
      current = join(current, part);
      if (!lstatSync(current).isDirectory()) throw new Error("private directory changed");
    }
  }
  directory(rel: string): string {
    let current = this.root;
    for (const part of rel.split("/")) {
      if (!part || part === "." || part === ".." || part.includes("\0") || part.includes("\\"))
        throw new Error("invalid storage directory");
      current = join(current, part);
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const st = lstatSync(current);
      if (!st.isDirectory()) throw new Error("private directory must not be a link");
      const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isDirectory()) throw new Error("private directory changed");
        fchmodSync(fd, 0o700);
      } finally {
        closeSync(fd);
      }
    }
    return current;
  }
  read(rel: string, maxBytes: number): Buffer | undefined {
    const path = this.path(rel);
    const before = lstatSync(path, { throwIfNoEntry: false });
    if (!before) return undefined;
    if (!before.isFile()) throw new Error("private file must be regular");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino)
        throw new Error("private file changed");
      if (st.size > maxBytes) throw new Error("private file is too large");
      this.#parents(dirname(path));
      const parts: Buffer[] = [];
      let total = 0;
      while (total <= maxBytes) {
        const b = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
        const n = readSync(fd, b, 0, b.length, null);
        if (!n) break;
        total += n;
        if (total > maxBytes) throw new Error("private file is too large");
        parts.push(b.subarray(0, n));
      }
      return Buffer.concat(parts, total);
    } finally {
      closeSync(fd);
    }
  }
  text(rel: string, maxBytes: number): string | undefined {
    const b = this.read(rel, maxBytes);
    return b === undefined
      ? undefined
      : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  }
  write(rel: string, text: string): void {
    const file = this.path(rel);
    const before = lstatSync(file, { throwIfNoEntry: false });
    if (before && !before.isFile()) throw new Error("private file must be regular");
    const parent = lstatSync(dirname(file));
    const temp = join(dirname(file), `.localdot-${randomBytes(12).toString("hex")}.tmp`);
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let closed = false;
    try {
      const bytes = Buffer.from(text);
      let offset = 0;
      while (offset < bytes.length) {
        const n = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!n) throw new Error("private write made no progress");
        offset += n;
      }
      fchmodSync(fd, 0o600);
      closeSync(fd);
      closed = true;
      this.#parents(dirname(file));
      const nowParent = lstatSync(dirname(file));
      const now = lstatSync(file, { throwIfNoEntry: false });
      if (
        parent.dev !== nowParent.dev ||
        parent.ino !== nowParent.ino ||
        (before ? !now || now.dev !== before.dev || now.ino !== before.ino : now !== undefined)
      )
        throw new Error("private destination changed");
      renameSync(temp, file);
    } finally {
      if (!closed) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }
  remove(rel: string): void {
    const path = this.path(rel);
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st && !st.isFile()) throw new Error("private file must be regular");
    rmSync(path, { force: true });
  }
}
export function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
