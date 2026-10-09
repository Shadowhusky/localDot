import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ULID_PATTERN, ulid } from "@localdot/protocol";

const LIMIT = 8192,
  MAX_RECORDS = 1024;
// Private deny/retirement records are canonical, bounded, and never repaired as a side effect of admission.
export class PrivateRecords<T> {
  readonly dir: string;
  constructor(
    home: string,
    name:
      | "fences"
      | "replacements"
      | "computer-resets"
      | "computer-reset-holds"
      | "computer-reset-releases"
      | "computer-updates",
    private readonly parse: (value: unknown, id: string) => T,
  ) {
    let dir = resolve(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#directory(dir);
    for (const part of ["safety", name]) {
      dir = join(dir, part);
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      this.#directory(dir);
    }
    this.dir = dir;
  }
  #directory(dir: string): void {
    const st = lstatSync(dir);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      (process.getuid && st.uid !== process.getuid()) ||
      st.mode & 0o077
    )
      throw new Error("unsafe private safety directory");
  }
  #path(id: string): string {
    if (!ULID_PATTERN.test(id)) throw new Error("invalid safety record identity");
    this.#directory(this.dir);
    return join(this.dir, id + ".json");
  }
  read(id: string): T | undefined {
    const path = this.#path(id),
      st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) return undefined;
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.mode & 0o077 ||
      st.size > LIMIT ||
      (process.getuid && st.uid !== process.getuid())
    )
      throw new Error("unsafe private safety record");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = fstatSync(fd);
      if (
        !actual.isFile() ||
        actual.dev !== st.dev ||
        actual.ino !== st.ino ||
        actual.mode & 0o077 ||
        actual.size > LIMIT ||
        (process.getuid && actual.uid !== process.getuid())
      )
        throw new Error("changed safety record");
      const bytes = Buffer.alloc(LIMIT + 1),
        n = readSync(fd, bytes, 0, bytes.length, 0);
      if (n > LIMIT || n !== actual.size) throw new Error("invalid safety record length");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n)),
        raw: unknown = JSON.parse(text);
      if (JSON.stringify(raw) + "\n" !== text) throw new Error("noncanonical safety record");
      return this.parse(raw, id);
    } finally {
      closeSync(fd);
    }
  }
  list(): T[] {
    this.#directory(this.dir);
    const entries = readdirSync(this.dir, { withFileTypes: true });
    if (entries.length > MAX_RECORDS) throw new Error("safety record capacity exhausted");
    const out: T[] = [];
    for (const entry of entries) {
      if (/^\.record-[0-9A-HJKMNP-TV-Z]{26}\.tmp$/.test(entry.name)) {
        const st = lstatSync(join(this.dir, entry.name));
        if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077 || st.size > LIMIT)
          throw new Error("unsafe temporary safety record");
        continue;
      }
      if (
        !entry.isFile() ||
        !ULID_PATTERN.test(entry.name.slice(0, -5)) ||
        !entry.name.endsWith(".json")
      )
        throw new Error("unexpected safety record");
      const record = this.read(entry.name.slice(0, -5));
      if (!record) throw new Error("safety record disappeared");
      out.push(record);
    }
    return out;
  }
  write(id: string, value: T): void {
    const target = this.#path(id),
      parsed = this.parse(value, id);
    this.read(id);
    if (
      !lstatSync(target, { throwIfNoEntry: false }) &&
      readdirSync(this.dir).length >= MAX_RECORDS
    )
      throw new Error("safety record capacity exhausted");
    const text = JSON.stringify(parsed) + "\n";
    if (Buffer.byteLength(text) > LIMIT) throw new Error("safety record too large");
    const temp = join(this.dir, `.record-${ulid()}.tmp`),
      fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    let open = true,
      renamed = false;
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
      closeSync(fd);
      open = false;
      this.#directory(this.dir);
      renameSync(temp, target);
      renamed = true;
      const parent = openSync(
        this.dir,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      try {
        if (!fstatSync(parent).isDirectory()) throw new Error("unsafe private directory");
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } catch (e) {
      if (open)
        try {
          closeSync(fd);
        } catch {}
      if (!renamed)
        try {
          unlinkSync(temp);
        } catch {}
      throw e;
    }
  }
}
