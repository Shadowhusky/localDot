import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CODEX_HOME_DENY_WRITE } from "./profile.ts";
import { assertOwnedCodexRoots, type OwnedCodexRoots, PRIVATE_CREATE_FLAGS } from "./roots.ts";

export const CODEX_CONFIG_TOML =
  "# Written by localDot before every start. localDot passes Codex's settings on its command line.\n";
const REMOVE = CODEX_HOME_DENY_WRITE.filter((name) => name !== "config.toml");
export class CodexHomeError extends Error {
  constructor() {
    super("The localDot Codex home could not be prepared safely.");
    this.name = "CodexHomeError";
  }
}
function refuse(): never {
  throw new CodexHomeError();
}
function inspect(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function ownedEntry(info: Stats): void {
  if (
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.isDirectory()
      ? (info.mode & 0o777) !== 0o700
      : !info.isFile() || info.nlink !== 1 || (info.mode & 0o022) !== 0)
  )
    refuse();
}
function same(path: string, before: Stats | undefined): void {
  const now = inspect(path);
  if (
    !before
      ? now !== undefined
      : !now ||
        now.dev !== before.dev ||
        now.ino !== before.ino ||
        now.mode !== before.mode ||
        now.uid !== before.uid ||
        now.nlink !== before.nlink
  )
    refuse();
}
// AuthOwner retires every credential holder before this synchronous preparation. All known
// removal trees are preflighted before any mutation; no caller path is a cleanup authority.
export function prepareCodexHome(roots: OwnedCodexRoots): void {
  let temporary: { path: string; info: Stats } | undefined;
  let failed = false;
  try {
    assertOwnedCodexRoots(roots);
    const auth = inspect(join(roots.home, "auth.json"));
    if (
      auth &&
      (!auth.isFile() ||
        auth.isSymbolicLink() ||
        auth.uid !== process.getuid?.() ||
        auth.nlink !== 1 ||
        (auth.mode & 0o777) !== 0o600)
    )
      refuse();
    const configPath = join(roots.home, "config.toml"),
      config = inspect(configPath);
    if (config) {
      ownedEntry(config);
      if (!config.isFile()) refuse();
    }
    const receipts = new Map<string, Stats>();
    let entries = 0;
    function walk(path: string, depth: number): void {
      const info = inspect(path);
      if (!info) return;
      if (++entries > 4096 || depth > 32) refuse();
      ownedEntry(info);
      receipts.set(path, info);
      if (info.isDirectory())
        for (const name of readdirSync(path)) walk(join(path, name), depth + 1);
    }
    for (const name of REMOVE) walk(join(roots.home, name), 0);
    assertOwnedCodexRoots(roots);
    same(join(roots.home, "auth.json"), auth);
    same(configPath, config);
    for (const [path, info] of receipts) same(path, info);
    const path = join(roots.home, `.localdot-config-${randomBytes(16).toString("hex")}.tmp`);
    const fd = openSync(path, PRIVATE_CREATE_FLAGS, 0o600);
    try {
      temporary = { path, info: fstatSync(fd) };
      writeFileSync(fd, CODEX_CONFIG_TOML);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    for (const name of REMOVE) {
      const target = join(roots.home, name),
        info = receipts.get(target);
      if (info) {
        assertOwnedCodexRoots(roots);
        same(target, info);
        rmSync(target, { recursive: true });
      }
    }
    assertOwnedCodexRoots(roots);
    same(join(roots.home, "auth.json"), auth);
    same(configPath, config);
    renameSync(path, configPath);
    temporary = undefined;
  } catch {
    failed = true;
  }
  if (temporary) {
    try {
      assertOwnedCodexRoots(roots);
      same(temporary.path, temporary.info);
      unlinkSync(temporary.path);
    } catch {
      failed = true;
    }
  }
  if (failed) refuse();
}
