import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "./copy-inventory.ts";
import type { InstallLockLifetime } from "./install-lock.ts";
import { privateRecordStore } from "./private-record.ts";

type Identity = Readonly<{ dev: string; ino: string; birthtimeNs: string }>;
type Record = Readonly<{ v: 1; parent: Identity; name: string; directory: Identity }>;
const fail = () =>
  new Error("Interrupted release preparation requires inspection; ownership or lifetime changed.");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
function fields(value: unknown, keys: string[]): { [key: string]: unknown } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",")
  )
    throw fail();
  return value as { [key: string]: unknown };
}
function identity(value: unknown): Identity {
  const v = fields(value, ["dev", "ino", "birthtimeNs"]);
  for (const key of ["dev", "ino", "birthtimeNs"])
    if (typeof v[key] !== "string" || !/^(?:0|[1-9][0-9]{0,24})$/.test(v[key])) throw fail();
  return { dev: v.dev as string, ino: v.ino as string, birthtimeNs: v.birthtimeNs as string };
}
const schema = {
  parse(value: unknown): Record | null {
    if (value === null) return null;
    const v = fields(value, ["v", "parent", "name", "directory"]);
    if (v.v !== 1 || typeof v.name !== "string" || !/^\.assembly-[a-f0-9]{32}$/.test(v.name))
      throw fail();
    return { v: 1, parent: identity(v.parent), name: v.name, directory: identity(v.directory) };
  },
};
const snapshot = (s: { dev: bigint; ino: bigint; birthtimeNs: bigint }): Identity => ({
  dev: String(s.dev),
  ino: String(s.ino),
  birthtimeNs: String(s.birthtimeNs),
});
function matches(s: { dev: bigint; ino: bigint; birthtimeNs: bigint }, id: Identity) {
  return (
    s.dev.toString() === id.dev &&
    s.ino.toString() === id.ino &&
    s.birthtimeNs.toString() === id.birthtimeNs
  );
}
function assertLifetime(parent: string, lifetime: InstallLockLifetime) {
  if (!lifetime || lifetime.directory !== parent) throw fail();
  lifetime.inheritDescriptor();
}
async function owned(path: string, id: Identity) {
  if (!matches(await privateDirectory(path), id)) throw fail();
}
async function sync(path: string, id: Identity) {
  await owned(path, id);
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!matches(await fd.stat({ bigint: true }), id)) throw fail();
    await fd.sync();
  } finally {
    await fd.close();
  }
  await owned(path, id);
}
const storeAt = (parent: string) => privateRecordStore(parent, "assembly-scratch.json", schema);
async function retire(parent: string, record: Record, lifetime: InstallLockLifetime) {
  assertLifetime(parent, lifetime);
  await owned(parent, record.parent);
  const store = storeAt(parent);
  if (JSON.stringify(await store.read()) !== JSON.stringify(record)) throw fail();
  const path = join(parent, record.name);
  let present = true;
  try {
    await lstat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    present = false;
  }
  if (present) {
    await owned(path, record.directory);
    await owned(parent, record.parent);
    assertLifetime(parent, lifetime);
    // Native preparation children retain this mutex until actual process exit; no cooperating
    // writer can survive into a new holder's recovery. Never search by prefix, age or PID.
    await rm(path, { recursive: true, force: false });
  }
  await sync(parent, record.parent);
  try {
    await lstat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    assertLifetime(parent, lifetime);
    await store.save(null);
    return;
  }
  throw fail();
}

export async function recoverAssemblyScratch(
  parent: string,
  signal: AbortSignal,
  lifetime: InstallLockLifetime,
) {
  signal.throwIfAborted();
  assertLifetime(parent, lifetime);
  await privateDirectory(parent);
  const record = await storeAt(parent).read();
  signal.throwIfAborted();
  if (record) await retire(parent, record, lifetime);
}

/** Persist ownership while empty. Caller must keep the inherited installation lifetime for all
 * native children and drain all work before disposal. This grants no release activation right. */
export async function createAssemblyScratch(
  parent: string,
  signal: AbortSignal,
  lifetime: InstallLockLifetime,
) {
  signal.throwIfAborted();
  assertLifetime(parent, lifetime);
  const parentId = snapshot(await privateDirectory(parent));
  const store = storeAt(parent);
  if (await store.read()) throw fail();
  signal.throwIfAborted();
  const name = `.assembly-${randomBytes(16).toString("hex")}`,
    directory = join(parent, name);
  await mkdir(directory, { mode: 0o700 });
  const directoryId = snapshot(await privateDirectory(directory));
  const record: Record = { v: 1, parent: parentId, name, directory: directoryId };
  await sync(directory, directoryId);
  await sync(parent, parentId);
  assertLifetime(parent, lifetime);
  await store.save(record);
  let disposal: Promise<void> | undefined;
  return Object.freeze({
    directory,
    async assertOwned() {
      assertLifetime(parent, lifetime);
      await owned(parent, parentId);
      if (JSON.stringify(await store.read()) !== JSON.stringify(record)) throw fail();
      await owned(directory, directoryId);
    },
    dispose() {
      assertLifetime(parent, lifetime);
      disposal ??= retire(parent, record, lifetime);
      return disposal;
    },
  });
}
