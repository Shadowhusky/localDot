import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { extname, join } from "node:path";

export class PlaceError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = "PlaceError";
  }
}

// A name a released download may take: one path component, already cleaned by the daemon's
// safeFileName; anything else is refused rather than cleaned twice.
const NAME = /^[^/\\\u{0}-\u{1f}\u{7f}]{1,130}$/u;

// Puts a released download into ~/Downloads (spec "Files between you and the computer"; P8-R16).
// The agent owns the home, so it may have planted links: Downloads must be a real directory, the
// file is created new (O_EXCL), never through a link (O_NOFOLLOW), never over an existing file
// (a name that is taken gets " (1)", " (2)"…), and never executable (0644, whatever the umask).
export function placeDownload(home: string, name: string, bytes: Uint8Array): string {
  if (!NAME.test(name) || name === "." || name === ".." || name.startsWith("."))
    throw new PlaceError(400, "invalid file name");
  const dir = join(home, "Downloads");
  if (!lstatSync(dir, { throwIfNoEntry: false })) mkdirSync(dir, { mode: 0o755 });
  // The folder is opened once, refusing a link; every name is then created inside that open
  // folder through /proc/self/fd, so swapping ~/Downloads for a link afterwards changes nothing.
  let dirFd: number;
  try {
    dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new PlaceError(409, "~/Downloads is not a folder");
  }
  try {
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let n = 0; n < 100; n++) {
      const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
      let fd: number;
      try {
        fd = openSync(
          `/proc/self/fd/${dirFd}/${candidate}`,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o644,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
      try {
        fchmodSync(fd, 0o644);
        let off = 0;
        while (off < bytes.length) off += writeSync(fd, bytes, off);
      } finally {
        closeSync(fd);
      }
      return `~/Downloads/${candidate}`;
    }
    throw new PlaceError(409, "too many files with that name in ~/Downloads");
  } finally {
    closeSync(dirFd);
  }
}
