import { constants, lstatSync, mkdirSync, mkdtempSync, realpathSync, type Stats } from "node:fs";
import { lstat, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export interface OwnedCodexRoots {
  readonly root: string;
  readonly home: string;
  readonly binRoot: string;
  readonly workRoot: string;
  readonly runRoot: string;
  readonly profilesRoot: string;
}

type Area = "binRoot" | "workRoot" | "runRoot" | "profilesRoot";
type Identity = { dev: number; ino: number };
const owners = new WeakMap<OwnedCodexRoots, { anchor: string; realHome: string }>();
const directories = new WeakMap<
  OwnedCodexDirectory,
  { roots: OwnedCodexRoots; area: Area; identity: Identity }
>();
export interface OwnedCodexDirectory {
  readonly path: string;
}

export class CodexRootsError extends Error {
  constructor() {
    super("The localDot Codex folders could not be verified.");
    this.name = "CodexRootsError";
  }
}
function refuse(): never {
  throw new CodexRootsError();
}
const below = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const overlap = (a: string, b: string) => a === b || below(a, b) || below(b, a);

function existingAncestor(path: string): { info: Stats; tail: string } {
  const tail: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return { info: lstatSync(current), tail: tail.join(sep) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === dirname(current))
        throw error;
      tail.unshift(basename(current));
    }
  }
}

// Normalize verified OS aliases even when the final managed/protected suffix does not exist.
// macOS firmlinks can preserve both spellings after realpath, so compare existing ancestors.
function osSpelling(input: string): string {
  let path = normalize(input);
  for (const alias of ["/tmp", "/var", "/etc"]) {
    if (path === alias || below(alias, path)) {
      const info = lstatSync(alias);
      if (info.isSymbolicLink()) {
        if (info.uid !== 0) return refuse();
        path = join(realpathSync(alias), relative(alias, path));
      }
      break;
    }
  }
  const data = "/System/Volumes/Data";
  if (process.platform === "darwin" && below(data, path)) {
    const natural = join(sep, relative(data, path));
    const original = existingAncestor(path),
      alternate = existingAncestor(natural);
    if (
      original.info.isDirectory() &&
      alternate.info.isDirectory() &&
      !original.info.isSymbolicLink() &&
      !alternate.info.isSymbolicLink() &&
      original.info.dev === alternate.info.dev &&
      original.info.ino === alternate.info.ino &&
      original.tail === alternate.tail
    )
      path = natural;
  }
  return path;
}

// Existing ancestors must not give an untrusted owner/group replacement authority. Root-owned
// sticky OS temporary parents protect this user's private entries and remain usable.
function canonicalInput(input: string): string {
  if (!isAbsolute(input) || input.includes("\0")) return refuse();
  if (input.split(sep).some((part) => part === ".." || part === ".")) return refuse();
  const path = osSpelling(input);
  const uid = process.getuid?.();
  if (uid === undefined) return refuse();
  let current: string = sep;
  let missing = false;
  for (const component of path.slice(1).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (missing) continue;
    try {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return refuse();
      if (info.uid !== 0 && info.uid !== uid) return refuse();
      if ((info.mode & 0o022) !== 0 && !((info.mode & 0o1000) !== 0 && info.uid === 0))
        return refuse();
      if (realpathSync(current) !== current) return refuse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true;
      else throw error;
    }
  }
  return path;
}

function checkPrivate(path: string, allowMissing = false): void {
  try {
    const info = lstatSync(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700
    )
      refuse();
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function protectedHome(home: string, candidate: string): void {
  if (candidate === home || below(candidate, home) || overlap(join(home, ".codex"), candidate))
    refuse();
  // macOS firmlinks may retain their spelling after realpath; inode identity still protects them.
  const real = lstatSync(home);
  let userCodex: ReturnType<typeof lstatSync> | undefined;
  let codexEntry: ReturnType<typeof lstatSync> | undefined;
  try {
    codexEntry = lstatSync(join(home, ".codex"));
    const codexPath = osSpelling(realpathSync(join(home, ".codex")));
    if (overlap(codexPath, candidate)) refuse();
    userCodex = lstatSync(codexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A present but unresolved alias is ambiguous, not an absent protected directory.
    if (codexEntry) refuse();
  }
  try {
    const info = lstatSync(candidate);
    for (let path = home; ; path = dirname(path)) {
      const ancestor = lstatSync(path);
      if (ancestor.dev === info.dev && ancestor.ino === info.ino) refuse();
      if (path === dirname(path)) break;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (let path = candidate; path !== dirname(path); path = dirname(path)) {
    try {
      const info = lstatSync(path);
      if (
        (info.dev === real.dev && info.ino === real.ino && path === candidate) ||
        (userCodex && info.dev === userCodex.dev && info.ino === userCodex.ino)
      )
        refuse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// This prerequisite from Task3 is shared with the installer: no lexical caller path can be a
// mutation/cleanup capability. All existing managed components are checked before any mkdir.
export function prepareOwnedCodexRoots(localdotHome: string, realHome: string): OwnedCodexRoots {
  try {
    const home = canonicalInput(realpathSync(realHome));
    if (!lstatSync(home).isDirectory()) refuse();
    const anchor = canonicalInput(localdotHome);
    protectedHome(home, anchor);
    const root = join(anchor, "codex");
    protectedHome(home, root);
    const roots = Object.freeze({
      root,
      home: join(root, "home"),
      binRoot: join(root, "bin"),
      workRoot: join(root, "work"),
      runRoot: join(root, "run"),
      profilesRoot: join(root, "profiles"),
    });
    const managed = [anchor, ...Object.values(roots)];
    // A missing anchor may have several missing ancestors. They must be owned private folders,
    // and their existing parent chain must have already passed canonicalInput.
    const missing: string[] = [];
    let ancestor = anchor;
    while (true) {
      try {
        lstatSync(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.unshift(ancestor);
        ancestor = dirname(ancestor);
      }
    }
    for (const path of managed) {
      canonicalInput(path);
      checkPrivate(path, true);
    }
    for (const path of [...missing, ...managed]) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      canonicalInput(path);
      checkPrivate(path);
    }
    owners.set(roots, { anchor, realHome: home });
    return roots;
  } catch {
    return refuse();
  }
}

export function assertOwnedCodexRoots(roots: OwnedCodexRoots): void {
  try {
    const owner = owners.get(roots);
    if (!owner) refuse();
    for (const path of [owner.anchor, ...Object.values(roots)]) {
      canonicalInput(path);
      protectedHome(owner.realHome, path);
      checkPrivate(path);
    }
  } catch {
    refuse();
  }
}

export function ownedCodexRealHome(roots: OwnedCodexRoots): string {
  assertOwnedCodexRoots(roots);
  const owner = owners.get(roots);
  if (!owner) return refuse();
  return owner.realHome;
}

export function assertOwnedCodexDirectory(
  roots: OwnedCodexRoots,
  directory: OwnedCodexDirectory,
  area: Area,
): void {
  assertOwnedCodexRoots(roots);
  const owner = directories.get(directory);
  if (!owner || owner.roots !== roots || owner.area !== area) refuse();
  if (dirname(directory.path) !== roots[area]) refuse();
  const info = lstatSync(directory.path);
  if (info.dev !== owner.identity.dev || info.ino !== owner.identity.ino) refuse();
  canonicalInput(directory.path);
  checkPrivate(directory.path);
}

export function createOwnedCodexDirectory(roots: OwnedCodexRoots, area: Area): OwnedCodexDirectory {
  assertOwnedCodexRoots(roots);
  const path = mkdtempSync(join(roots[area], ".owned-"));
  checkPrivate(path);
  const info = lstatSync(path);
  const directory = Object.freeze({ path });
  directories.set(directory, { roots, area, identity: { dev: info.dev, ino: info.ino } });
  return directory;
}

async function checkDirectory(directory: OwnedCodexDirectory): Promise<boolean> {
  const owner = directories.get(directory);
  if (!owner) return refuse();
  assertOwnedCodexRoots(owner.roots);
  if (dirname(directory.path) !== owner.roots[owner.area]) return refuse();
  try {
    const info = await lstat(directory.path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== owner.identity.dev ||
      info.ino !== owner.identity.ino ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700
    )
      return refuse();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function removeOwnedCodexDirectory(directory: OwnedCodexDirectory): Promise<void> {
  if (await checkDirectory(directory)) await rm(directory.path, { recursive: true });
}

export function codexInstallDirectory(roots: OwnedCodexRoots, key: string): string {
  assertOwnedCodexRoots(roots);
  if (!/^0\.154\.0-[a-f0-9]{64}$/.test(key)) return refuse();
  return join(roots.binRoot, key);
}

export async function publishOwnedCodexDirectory(
  directory: OwnedCodexDirectory,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  const owner = directories.get(directory);
  if (
    owner?.area !== "binRoot" ||
    dirname(target) !== owner.roots.binRoot ||
    !/^0\.154\.0-[a-f0-9]{64}$/.test(relative(owner.roots.binRoot, target)) ||
    !(await checkDirectory(directory))
  )
    refuse();
  // rename never follows a target link. A nonempty installation is never removed to make room.
  try {
    await lstat(target);
    refuse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  signal?.throwIfAborted();
  await rename(directory.path, target);
}

export const PRIVATE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
export const PRIVATE_CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
