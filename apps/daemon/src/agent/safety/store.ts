import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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
export class SafetyIntentStore {
  constructor(private readonly home: string) {}
  write(sessionId: string, cellId: string, policy: AutonomyPolicy, pause: Pause | undefined): void {
    if (!ULID_PATTERN.test(sessionId) || !ULID_PATTERN.test(cellId))
      throw new Error("invalid safety owner");
    const data =
      JSON.stringify({
        version: 1,
        sessionId,
        cellId,
        policy: AutonomyPolicy.parse(policy),
        ...(pause ? { pause: PauseSnapshot.parse(pause) } : {}),
      }) + "\n";
    if (Buffer.byteLength(data) > 8192) throw new Error("safety intent too large");
    let dir = resolve(this.home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const root = lstatSync(dir);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("unsafe safety home");
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
      if (!st.isFile() || st.isSymbolicLink() || st.size > 8192 || st.mode & 0o077)
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
