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
import {
  AutonomyPolicy,
  type PauseSnapshot as Pause,
  PauseSnapshot,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import { z } from "zod";

const Intent = z.strictObject({
  version: z.literal(1),
  sessionId: z.string().regex(ULID_PATTERN),
  cellId: z.string().regex(ULID_PATTERN),
  policy: AutonomyPolicy,
  pause: PauseSnapshot.optional(),
  executor: z.enum(["api", "native"]).optional(),
});
export type SafetyIntent = z.infer<typeof Intent>;
export interface RefusedIntent {
  sessionId: string;
  cellId?: string;
}
export class SafetyIntentStore {
  constructor(private readonly home: string) {}
  #privateDirectory(path: string): void {
    const st = lstatSync(path);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      st.mode & 0o077 ||
      (process.getuid && st.uid !== process.getuid())
    )
      throw new Error("unsafe safety directory");
  }
  read(sessionId: string): SafetyIntent | undefined {
    if (!ULID_PATTERN.test(sessionId)) throw new Error("invalid safety owner");
    const root = resolve(this.home);
    this.#privateDirectory(root);
    const sessions = join(root, "sessions");
    if (!lstatSync(sessions, { throwIfNoEntry: false })) return undefined;
    this.#privateDirectory(sessions);
    const dir = join(sessions, sessionId);
    if (!lstatSync(dir, { throwIfNoEntry: false })) return undefined;
    this.#privateDirectory(dir);
    const target = join(dir, "safety.json"),
      st = lstatSync(target, { throwIfNoEntry: false });
    if (!st) return undefined;
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.mode & 0o077 ||
      st.size > 8192 ||
      (process.getuid && st.uid !== process.getuid())
    )
      throw new Error("unsafe safety intent");
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = fstatSync(fd);
      if (
        !actual.isFile() ||
        actual.dev !== st.dev ||
        actual.ino !== st.ino ||
        actual.mode & 0o077 ||
        actual.size > 8192 ||
        (process.getuid && actual.uid !== process.getuid())
      )
        throw new Error("changed safety intent");
      const bytes = Buffer.alloc(8193),
        n = readSync(fd, bytes, 0, bytes.length, 0);
      if (n > 8192 || n !== actual.size) throw new Error("invalid safety intent length");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n)),
        raw: unknown = JSON.parse(text);
      if (JSON.stringify(raw) + "\n" !== text) throw new Error("noncanonical safety intent");
      const record = Intent.parse(raw);
      if (record.sessionId !== sessionId) throw new Error("safety intent owner mismatch");
      return record;
    } finally {
      closeSync(fd);
    }
  }
  // Session history shares this directory: only a session that holds safety.json is an owner.
  scan(): { intents: SafetyIntent[]; refused: RefusedIntent[] } {
    const root = resolve(this.home);
    this.#privateDirectory(root);
    const sessions = join(root, "sessions");
    const intents: SafetyIntent[] = [],
      refused: RefusedIntent[] = [];
    if (!lstatSync(sessions, { throwIfNoEntry: false })) return { intents, refused };
    this.#privateDirectory(sessions);
    for (const entry of readdirSync(sessions, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ULID_PATTERN.test(entry.name)) continue;
      try {
        if (!lstatSync(join(sessions, entry.name, "safety.json"), { throwIfNoEntry: false }))
          continue;
        const record = this.read(entry.name);
        if (record) intents.push(record);
      } catch {
        const cellId = this.#namedCell(join(sessions, entry.name, "safety.json"));
        refused.push({ sessionId: entry.name, ...(cellId ? { cellId } : {}) });
      }
    }
    return { intents, refused };
  }
  // A refused intent is never trusted, but the computer it names can still be fenced.
  #namedCell(target: string): string | undefined {
    try {
      const st = lstatSync(target);
      if (!st.isFile() || st.size > 8192) return undefined;
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(8192),
          n = readSync(fd, bytes, 0, bytes.length, 0),
          raw: unknown = JSON.parse(bytes.subarray(0, n).toString("utf8"));
        const cellId = (raw as { cellId?: unknown } | null)?.cellId;
        return typeof cellId === "string" && ULID_PATTERN.test(cellId) ? cellId : undefined;
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
  }
  write(
    sessionId: string,
    cellId: string,
    policy: AutonomyPolicy,
    pause: Pause | undefined,
    executor?: "api" | "native",
  ): void {
    if (!ULID_PATTERN.test(sessionId) || !ULID_PATTERN.test(cellId))
      throw new Error("invalid safety owner");
    const data =
      JSON.stringify({
        version: 1,
        sessionId,
        cellId,
        policy: AutonomyPolicy.parse(policy),
        ...(pause ? { pause: PauseSnapshot.parse(pause) } : {}),
        ...(executor ? { executor } : {}),
      }) + "\n";
    if (Buffer.byteLength(data) > 8192) throw new Error("safety intent too large");
    let dir = resolve(this.home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const root = lstatSync(dir);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.mode & 0o077 ||
      (process.getuid && root.uid !== process.getuid())
    )
      throw new Error("unsafe safety home");
    for (const part of ["sessions", sessionId]) {
      dir = join(dir, part);
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = lstatSync(dir);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.mode & 0o077
      )
        throw new Error("unsafe safety directory");
    }
    const target = join(dir, "safety.json"),
      temp = join(dir, `.safety-${ulid()}.tmp`);
    const st = lstatSync(target, { throwIfNoEntry: false });
    if (st) {
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        st.size > 8192 ||
        st.mode & 0o077 ||
        (process.getuid && st.uid !== process.getuid())
      )
        throw new Error("unsafe safety intent");
    }
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let renamed = false,
      fdOpen = true;
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      fdOpen = false;
      renameSync(temp, target);
      renamed = true;
      const parent = openSync(
        dir,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      try {
        if (!fstatSync(parent).isDirectory()) throw new Error("unsafe safety directory");
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } catch (error) {
      if (fdOpen)
        try {
          closeSync(fd);
        } catch {}
      if (!renamed)
        try {
          unlinkSync(temp);
        } catch {}
      throw error;
    }
  }
}
