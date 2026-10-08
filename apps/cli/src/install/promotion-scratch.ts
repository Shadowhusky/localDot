import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "./copy-inventory.ts";
import { privateRecordStore } from "./private-record.ts";

type Identity = Readonly<{ dev: string; ino: string }>;
type ScratchRecord = Readonly<{
  v: 1;
  parent: Identity;
  name: string;
  directory: Identity;
}>;
const fail = () =>
  new Error("Interrupted release copy requires inspection; its ownership changed.");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw fail();
  return value as Record<string, unknown>;
}
function identity(value: unknown): Identity {
  const record = object(value, ["dev", "ino"]);
  for (const key of ["dev", "ino"])
    if (typeof record[key] !== "string" || !/^(?:0|[1-9][0-9]{0,24})$/.test(record[key]))
      throw fail();
  return { dev: record.dev as string, ino: record.ino as string };
}
const schema = {
  parse(value: unknown): ScratchRecord | null {
    if (value === null) return null;
    const record = object(value, ["v", "parent", "name", "directory"]);
    if (
      record.v !== 1 ||
      typeof record.name !== "string" ||
      !/^\.promote-[a-f0-9]{32}$/.test(record.name)
    )
      throw fail();
    return {
      v: 1,
      parent: identity(record.parent),
      name: record.name,
      directory: identity(record.directory),
    };
  },
};
function snapshot(stat: { dev: bigint; ino: bigint }): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function matches(stat: { dev: bigint; ino: bigint }, expected: Identity) {
  return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
}
async function checkParent(parent: string, expected: Identity) {
  if (!matches(await privateDirectory(parent), expected)) throw fail();
}
async function syncDirectory(path: string, expected: Identity) {
  await checkParent(path, expected);
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!matches(await fd.stat({ bigint: true }), expected)) throw fail();
    await fd.sync();
  } finally {
    await fd.close();
  }
  await checkParent(path, expected);
}
function storeAt(parent: string) {
  return privateRecordStore(parent, "promotion-scratch.json", schema);
}

async function retire(parent: string, record: ScratchRecord) {
  await checkParent(parent, record.parent);
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
    // No executable runs out of a promotion copy. The install mutex excludes all cooperating
    // writers, so a crashed copier has no surviving worker that can repopulate this tree.
    if (!matches(await privateDirectory(path), record.directory)) throw fail();
    await checkParent(parent, record.parent);
    await rm(path, { recursive: true, force: false });
  }
  // Missing is also valid after the atomic promotion rename. Never derive or remove its target.
  await syncDirectory(parent, record.parent);
  try {
    await lstat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    await store.save(null);
    return;
  }
  throw fail();
}

/** Caller holds the installation mutex. Recover only the recorded inode, never enumerate old
 * names or infer ownership from age. Replacement/unsafe records refuse all deletion. Retiring
 * an interrupted removal is repeatable; a promoted payload is never a cleanup target.
 */
export async function recoverPromotionScratch(parent: string, signal: AbortSignal) {
  signal.throwIfAborted();
  await privateDirectory(parent);
  const record = await storeAt(parent).read();
  signal.throwIfAborted();
  if (record) await retire(parent, record);
}

/** Caller holds the same mutex until dispose settles. Persist ownership before any payload
 * bytes are copied. A crash before record publication can leave only an empty unclaimed folder;
 * it is deliberately not adopted. This scope is not for native probes or bootstrap helpers.
 */
export async function createPromotionScratch(parent: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const owner = snapshot(await privateDirectory(parent));
  const store = storeAt(parent);
  if (await store.read()) throw fail();
  signal.throwIfAborted();
  const name = `.promote-${randomBytes(16).toString("hex")}`;
  const directory = join(parent, name);
  await mkdir(directory, { mode: 0o700 });
  const owned = snapshot(await privateDirectory(directory));
  const record: ScratchRecord = { v: 1, parent: owner, name, directory: owned };
  await syncDirectory(directory, owned);
  await syncDirectory(parent, owner);
  await store.save(record);
  // Do not abort between publication and returning its disposal capability. The caller's
  // guarded copy checks cancellation and then retires the now durably recorded directory.
  let disposal: Promise<void> | undefined;
  return Object.freeze({
    directory,
    async assertOwned() {
      await checkParent(parent, owner);
      if (JSON.stringify(await store.read()) !== JSON.stringify(record)) throw fail();
      if (!matches(await privateDirectory(directory), owned)) throw fail();
    },
    dispose() {
      disposal ??= retire(parent, record);
      return disposal;
    },
  });
}
