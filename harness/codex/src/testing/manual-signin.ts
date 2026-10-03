import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

// Internal manual acceptance helpers. Never inspect credential contents in the user's home.
export function requireManualSignIn(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  arch = process.arch,
): void {
  assert.ok(
    env.LOCALDOT_CODEX_TESTS === "1" && env.LOCALDOT_CODEX_SIGNIN === "1",
    "Real sign-in requires both explicit acceptance flags.",
  );
  assert.ok(platform === "darwin" && arch === "arm64", "Manual sign-in needs Apple silicon macOS.");
  assert.ok(
    env.LOCALDOT_CODEX_ARCHIVE,
    "Supply the independently verified cached release archive.",
  );
}
export function userCredentialMetadata(home: string): unknown[] {
  return [".codex", ".codex/auth.json", ".codex/config.toml"].map((relative) => {
    try {
      const info = lstatSync(join(home, relative), { bigint: true });
      return {
        relative,
        dev: info.dev,
        ino: info.ino,
        mode: info.mode,
        uid: info.uid,
        nlink: info.nlink,
        size: info.size,
        mtime: info.mtimeNs,
        ctime: info.ctimeNs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { relative, absent: true };
      throw new Error("The user's credential metadata could not be checked.");
    }
  });
}
export function privateAuthRefresh(home: string): number {
  const path = join(home, "auth.json");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    assert.ok(
      info.isFile() &&
        info.uid === process.getuid?.() &&
        info.nlink === 1 &&
        (info.mode & 0o777) === 0o600 &&
        info.size > 0 &&
        info.size <= 65_536,
      "The owned sign-in file must be private and bounded.",
    );
    const bytes = Buffer.alloc(65_537);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    assert.ok(length > 0 && length <= 65_536, "The owned sign-in file exceeds its limit.");
    let auth: Record<string, unknown>;
    try {
      auth = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    } catch {
      throw new Error("The owned sign-in file is invalid.");
    } finally {
      bytes.fill(0);
    }
    const tokens = auth?.tokens as Record<string, unknown> | undefined;
    assert.ok(
      auth?.auth_mode === "chatgpt" &&
        !auth.OPENAI_API_KEY &&
        tokens &&
        typeof tokens.refresh_token === "string" &&
        tokens.refresh_token.length > 0 &&
        typeof auth.last_refresh === "string",
      "The owned sign-in file must contain ChatGPT credentials.",
    );
    const refreshed = Date.parse(auth.last_refresh as string);
    assert.ok(Number.isFinite(refreshed), "The owned refresh timestamp is invalid.");
    return refreshed;
  } finally {
    closeSync(descriptor);
  }
}
