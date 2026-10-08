import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { privateDirectory } from "./copy-inventory.ts";

const failure = () => new Error("The installation directory is unavailable or unsafe.");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

function checkedHome(home: string) {
  if (
    !isAbsolute(home) ||
    normalize(home) !== home ||
    home === "/" ||
    home.length > 1000 ||
    [...home].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw failure();
}

/** Read-only discovery. An unsafe existing path is an error, never a missing installation. */
export async function hasInstallState(home: string): Promise<boolean> {
  checkedHome(home);
  for (const path of [home, join(home, "install")]) {
    try {
      await lstat(path);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    await privateDirectory(path);
  }
  return true;
}

async function parentDirectory(path: string) {
  const stat = await lstat(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.uid !== BigInt(process.getuid?.() ?? -1) ||
    (stat.mode & 0o022n) !== 0n ||
    (await realpath(path)) !== path
  )
    throw failure();
  return stat;
}

async function createPrivate(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const parent = dirname(path),
    before = await parentDirectory(parent);
  const fd = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await fd.stat({ bigint: true });
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw failure();
    signal.throwIfAborted();
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await privateDirectory(path);
    await fd.sync();
    const after = await parentDirectory(parent);
    if (after.ino !== before.ino || after.dev !== before.dev) throw failure();
    signal.throwIfAborted();
  } finally {
    await fd.close();
  }
}

/** Only after prerequisites pass. Create missing descendants of an existing safe user-owned
 * ancestor with mode 0700; never chmod, empty, replace or delete an existing directory. Concurrent
 * first installers may create the same directories; all other mutations wait for the helper lock.
 */
export async function initializeInstallHome(home: string, signal: AbortSignal) {
  checkedHome(home);
  signal.throwIfAborted();
  const pending: string[] = [];
  let ancestor = home;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (!missing(error)) throw error;
      pending.push(ancestor);
      const next = dirname(ancestor);
      if (next === ancestor) throw failure();
      ancestor = next;
    }
  }
  await parentDirectory(ancestor);
  for (const path of pending.reverse()) await createPrivate(path, signal);
  await privateDirectory(home);
  await createPrivate(join(home, "install"), signal);
  return { home, state: join(home, "install") };
}
