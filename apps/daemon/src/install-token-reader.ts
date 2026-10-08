import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/** Read existing authority only. Never create, rotate or repair a token to open a link. */
export function readInstallToken(home: string): string {
  if (!isAbsolute(home)) throw new Error("invalid installation home");
  const root = lstatSync(home),
    uid = process.getuid?.();
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (root.mode & 0o077) !== 0 ||
    (uid !== undefined && root.uid !== uid)
  )
    throw new Error("private installation home required");
  const file = join(realpathSync(home), "daemon-token"),
    before = lstatSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o077) !== 0 ||
    before.size > 1024 ||
    (uid !== undefined && before.uid !== uid)
  )
    throw new Error("private token required");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = fstatSync(fd);
    if (
      !actual.isFile() ||
      actual.nlink !== 1 ||
      (actual.mode & 0o077) !== 0 ||
      actual.size > 1024 ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      (uid !== undefined && actual.uid !== uid)
    )
      throw new Error("token changed");
    // Bound the read even if the same inode grows after fstat.
    const buffer = Buffer.alloc(1025);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > 1024) throw new Error("invalid token");
    const token = buffer.subarray(0, offset).toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("invalid token");
    return token;
  } finally {
    closeSync(fd);
  }
}
