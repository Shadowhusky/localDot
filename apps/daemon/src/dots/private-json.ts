import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

export class PrivateJsonError extends Error {}

// Undefined when the file does not exist. A file another user could change, or one that is not
// a plain file, is refused rather than read.
export function readPrivateJson(path: string, maxBytes = 64 * 1024): unknown {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PrivateJsonError(`${path} can't be read`);
  }
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (
      !stat.isFile() ||
      stat.size > maxBytes ||
      (stat.mode & 0o022) !== 0 ||
      (uid !== undefined && stat.uid !== uid)
    )
      throw new PrivateJsonError(`${path} isn't a private file of yours`);
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch (error) {
    if (error instanceof PrivateJsonError) throw error;
    throw new PrivateJsonError(`${path} isn't valid`);
  } finally {
    closeSync(fd);
  }
}

export function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
