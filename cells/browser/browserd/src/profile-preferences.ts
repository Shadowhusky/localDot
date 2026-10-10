import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";

const MAX_PREFERENCES_BYTES = 4 * 1024 * 1024;

function refuse(): never {
  throw new Error("Browser profile preferences unavailable");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identity(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function unchanged(first: Stats, second: Stats): boolean {
  return (
    identity(first, second) &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs &&
    second.nlink === 1
  );
}

async function directory(path: string): Promise<FileHandle> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const state = await handle.stat();
    if (!state.isDirectory() || state.uid !== 1000 || (state.mode & 0o777) !== 0o700) refuse();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// The shared profile moves between browser cells with different host names, and a cell stopped
// without Chromium's own clean exit leaves these links behind. The daemon mounts the profile in one
// cell at a time, so a link here is always stale, and Chromium would refuse a "profile in use".
export async function releaseProfileLocks(profilePath: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) refuse();
  const root = await directory(profilePath);
  try {
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      const path = `/proc/self/fd/${root.fd}/${name}`;
      try {
        if (!(await lstat(path)).isSymbolicLink()) refuse();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await unlink(path);
    }
  } finally {
    await root.close();
  }
}

/** Before Chromium starts, preserve its profile while disabling automatic download and password-save popups.
 * All child access is relative to retained directory descriptors; profile bytes stay local.
 */
export async function prepareProfilePreferences(
  profilePath: string,
  signal: AbortSignal,
): Promise<void> {
  const check = () => {
    if (signal.aborted) refuse();
  };
  check();
  const root = await directory(profilePath);
  let profile: FileHandle | undefined;
  let temporary: string | undefined;
  try {
    const rootState = await root.stat();
    const profileName = `/proc/self/fd/${root.fd}/Default`;
    try {
      await mkdir(profileName, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    profile = await directory(profileName);
    const profileState = await profile.stat();
    const directoryPath = `/proc/self/fd/${profile.fd}`;
    const preferences = `${directoryPath}/Preferences`;
    let original: Stats | undefined;
    let values: Record<string, unknown> = {};
    let input: FileHandle | undefined;
    try {
      input = await open(
        preferences,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      original = await input.stat();
      if (
        !original.isFile() ||
        original.uid !== 1000 ||
        original.nlink !== 1 ||
        (original.mode & 0o077) !== 0 ||
        original.size < 2 ||
        original.size > MAX_PREFERENCES_BYTES
      )
        refuse();
      const bytes = Buffer.alloc(original.size + 1);
      let read = 0;
      while (read < bytes.length) {
        check();
        const result = await input.read(bytes, read, bytes.length - read, read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      if (read !== original.size || !unchanged(original, await input.stat())) refuse();
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read)),
      );
      if (!object(parsed)) refuse();
      values = parsed;
    } catch (error) {
      if (input || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await input?.close();
    }
    const current = async () => {
      check();
      if (
        !identity(rootState, await lstat(profilePath)) ||
        !identity(profileState, await lstat(profileName))
      )
        refuse();
      try {
        const state = await lstat(preferences);
        if (!original || !unchanged(original, state)) refuse();
      } catch (error) {
        if (original || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    await current();
    const bubble = values.download_bubble;
    if (bubble !== undefined && !object(bubble)) refuse();
    if (
      object(bubble) &&
      bubble.partial_view_enabled === false &&
      values.credentials_enable_service === false
    )
      return;
    // keyd owns saved logins. Chromium's separate save bubble steals page focus after a
    // submitted form, leaving protected reads unable to inspect success or rejection.
    // Chromium: components/password_manager/core/common/password_manager_pref_names.h
    values.credentials_enable_service = false;
    values.download_bubble = { ...(object(bubble) ? bubble : {}), partial_view_enabled: false };
    const encoded = Buffer.from(JSON.stringify(values));
    if (encoded.length > MAX_PREFERENCES_BYTES) refuse();
    temporary = `${directoryPath}/.localdot-preferences-${randomUUID()}`;
    const output = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await output.writeFile(encoded);
      await output.sync();
      await current();
      await rename(temporary, preferences);
      temporary = undefined;
      await profile.sync();
      check();
    } finally {
      await output.close();
    }
  } finally {
    try {
      if (temporary) await unlink(temporary);
    } finally {
      try {
        await profile?.close();
      } finally {
        await root.close();
      }
    }
  }
}
