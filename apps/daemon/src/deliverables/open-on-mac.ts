import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { canOpenOnMac, fileExtension } from "@localdot/protocol";

export interface MacOpener {
  // ~/Downloads on the real Mac; a temporary folder in tests and the fixture daemon.
  downloads: string;
  platform: NodeJS.Platform;
  quarantine(path: string): Promise<void>;
  launch(path: string): Promise<void>;
}
export class OpenRefused extends Error {
  constructor(
    readonly status: 404 | 409 | 415 | 501,
    message: string,
  ) {
    super(message);
  }
}

// "Monthly report: Q3/Q4" → "Monthly report Q3 Q4 (3kq9zx)". Letters and digits of any script stay.
export function taskFolder(title: string | null, sessionId: string): string {
  const words = (title ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "");
  const short = [...words].slice(0, 60).join("").trim() || "Task";
  return `${short} (${sessionId.slice(-6).toLowerCase()})`;
}
// The name on the Mac: the newest version keeps the file's own name; an older one says which it is.
export function macName(name: string, label: number, newest: boolean, attempt: number): string {
  const ext = fileExtension(name);
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
  const tags = [...(newest ? [] : [`v${label}`]), ...(attempt > 1 ? [String(attempt)] : [])];
  return tags.length ? `${stem} (${tags.join(", ")})${ext ? `.${ext}` : ""}` : name;
}

// Copies one stored version to ~/Downloads/localDot/<task>/ without replacing anything, marks it as
// downloaded so macOS treats it like any other download, then opens it with its default app.
export async function openOnMac(
  opener: MacOpener,
  source: string,
  file: { name: string; label: number; newest: boolean },
  task: { title: string | null; sessionId: string },
): Promise<{ path: string; shown: string; reused: boolean }> {
  if (opener.platform !== "darwin") throw new OpenRefused(501, "Open on Mac needs macOS.");
  if (!canOpenOnMac(file.name))
    throw new OpenRefused(
      415,
      "dot can't open this kind of file on your Mac. Download it instead.",
    );
  const root = realpathSync(opener.downloads);
  const dir = join(root, "localDot", taskFolder(task.title, task.sessionId));
  for (const step of [join(root, "localDot"), dir]) {
    try {
      mkdirSync(step, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!lstatSync(step).isDirectory())
      throw new OpenRefused(409, "The localDot folder in Downloads is not a folder.");
  }
  const src = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(src).isFile()) throw new OpenRefused(404, "That file is no longer available.");
    const digest = hashOf(src);
    for (let attempt = 1; attempt <= 99; attempt++) {
      const dest = join(dir, macName(file.name, file.label, file.newest, attempt));
      const shown = `~/Downloads/${relative(root, dest)}`;
      const existing = lstatSync(dest, { throwIfNoEntry: false });
      if (existing) {
        if (existing.isFile() && sameContent(dest, digest)) {
          await opener.launch(dest);
          return { path: dest, shown, reused: true };
        }
        continue;
      }
      copyInto(src, dest);
      await opener.quarantine(dest);
      await opener.launch(dest);
      return { path: dest, shown, reused: false };
    }
    throw new OpenRefused(409, "Too many copies of this file in Downloads.");
  } finally {
    closeSync(src);
  }
}
function hashOf(fd: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (let position = 0; ; ) {
    const n = readSync(fd, buffer, 0, buffer.length, position);
    if (n === 0) return hash.digest("hex");
    hash.update(buffer.subarray(0, n));
    position += n;
  }
}
function sameContent(path: string, digest: string): boolean {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return hashOf(fd) === digest;
  } finally {
    closeSync(fd);
  }
}
function copyInto(src: number, dest: string): void {
  const out = openSync(
    dest,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  let ok = false;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let position = 0; ; ) {
      const n = readSync(src, buffer, 0, buffer.length, position);
      if (n === 0) break;
      for (let offset = 0; offset < n; ) offset += writeSync(out, buffer, offset, n - offset);
      position += n;
    }
    ok = true;
  } finally {
    closeSync(out);
    if (!ok) rmSync(dest, { force: true });
  }
}

export function macOpener(): MacOpener {
  const run = (file: string, args: string[]) =>
    new Promise<void>((resolve, reject) =>
      execFile(file, args, { timeout: 10_000 }, (error) => (error ? reject(error) : resolve())),
    );
  return {
    downloads: join(homedir(), "Downloads"),
    platform: process.platform,
    quarantine: (path) =>
      run("/usr/bin/xattr", [
        "-w",
        "com.apple.quarantine",
        `0083;${Math.floor(Date.now() / 1000).toString(16)};localDot;`,
        path,
      ]),
    // execFile, never a shell: the path is one argument and always absolute.
    launch: (path) => run("/usr/bin/open", [path]),
  };
}
