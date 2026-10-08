import { type BigIntStats, constants } from "node:fs";
import { lstat, open, opendir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeRetirementRecord } from "../../../../harness/codex/src/retirement-record.ts";
import { withCanaryDirectoryLease } from "./canary-lease.ts";
import { privateDirectory } from "./copy-inventory.ts";
import { keydNativeLeaseAcquirer, NativeLeaseBusy } from "./install-lock.ts";

const failure = () => new Error("Native task recovery could not be confirmed.");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const stable = (a: BigIntStats, b: BigIntStats) =>
  same(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.size === b.size;
const identity = (st: BigIntStats) => ({
  dev: String(st.dev),
  ino: String(st.ino),
  birthtimeNs: String(st.birthtimeNs),
});
const matches = (st: BigIntStats, expected: NativeRetirementRecord["work"]["identity"]) =>
  JSON.stringify(identity(st)) === JSON.stringify(expected);
type Resource = {
  path: string;
  parent: string;
  identity: NativeRetirementRecord["work"]["identity"];
};

/** Production entry: caller holds the install mutex and both stopped-service leases. The
 * separate profiles-directory lease excludes a surviving native supervisor after daemon death.
 * Only the pre-existing, exact retired receipts authorize cleanup; active/missing records refuse.
 */
export async function recoverNativeRetiredWithLease(
  home: string,
  signal: AbortSignal,
  verifiedKeydPath: string,
): Promise<void> {
  try {
    const root = join(home, "codex");
    await privateDirectory(home);
    try {
      await lstat(root);
    } catch (error) {
      if (!missing(error)) throw error;
      return await recoverNativeRetired(home, signal);
    }
    await privateDirectory(root);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    for (;;) {
      try {
        await withCanaryDirectoryLease(
          join(root, "profiles"),
          bounded,
          keydNativeLeaseAcquirer(verifiedKeydPath),
          () => recoverNativeRetired(home, bounded),
        );
        return;
      } catch (error) {
        if (!(error instanceof NativeLeaseBusy)) throw error;
        await delay(100, undefined, { signal: bounded });
      }
    }
  } catch {
    throw failure();
  }
}

async function names(path: string, signal: AbortSignal): Promise<string[]> {
  const directory = await opendir(path),
    result: string[] = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      const entry = await directory.read();
      if (!entry) return result;
      if (result.length === 4096 || Buffer.byteLength(entry.name) > 128) throw failure();
      result.push(entry.name);
    }
  } finally {
    await directory.close();
  }
}
function privateFile(st: BigIntStats) {
  if (
    !st.isFile() ||
    st.nlink !== 1n ||
    st.uid !== BigInt(process.getuid?.() ?? -1) ||
    (st.mode & 0o7777n) !== 0o600n ||
    st.size < 1n ||
    st.size > 8192n
  )
    throw failure();
}
async function readReceipt(path: string, name: string, signal: AbortSignal) {
  const before = await lstat(path, { bigint: true });
  privateFile(before);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await fd.stat({ bigint: true });
    privateFile(opened);
    if (!stable(before, opened)) throw failure();
    const bytes = Buffer.alloc(8193);
    let used = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await fd.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
      if (used > 8192) throw failure();
    }
    const after = await fd.stat({ bigint: true }),
      entry = await lstat(path, { bigint: true });
    privateFile(after);
    privateFile(entry);
    if (!stable(before, after) || !stable(before, entry) || BigInt(used) !== before.size)
      throw failure();
    const record = NativeRetirementRecord.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used))),
    );
    if (name !== `.retired-${record.nonce}.json`) throw failure();
    return { path, stat: before, record };
  } finally {
    await fd.close();
  }
}
async function present(resource: Resource) {
  try {
    await lstat(resource.path);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  const stat = await privateDirectory(resource.path);
  if (!matches(stat, resource.identity)) throw failure();
  return true;
}

/** Requires the installation mutex and both stopped-service lifetime leases throughout. A receipt
 * proves native retirement, not daemon/bridge retirement; service exclusion supplies the latter.
 * Validate the whole inventory before any deletion. Never infer retirement from a name, PID, age,
 * empty directory or missing receipt. The user's Codex home and managed credentials are not read.
 */
export async function recoverNativeRetired(home: string, signal: AbortSignal): Promise<void> {
  try {
    signal.throwIfAborted();
    const homeBefore = await privateDirectory(home),
      root = join(home, "codex");
    try {
      await lstat(root);
    } catch (error) {
      if (!missing(error) || !stable(homeBefore, await privateDirectory(home))) throw failure();
      signal.throwIfAborted();
      return;
    }
    const paths = {
      home,
      root,
      profiles: join(root, "profiles"),
      work: join(root, "work"),
      run: join(root, "run"),
    };
    const parents = new Map<string, BigIntStats>([[home, homeBefore]]);
    for (const path of Object.values(paths))
      if (!parents.has(path)) parents.set(path, await privateDirectory(path));
    const recheckParents = async (unchanged: boolean) => {
      signal.throwIfAborted();
      for (const [path, before] of parents) {
        const now = await privateDirectory(path);
        if (!(unchanged ? stable(before, now) : same(before, now))) throw failure();
      }
    };
    const inventory = new Map<string, string[]>();
    for (const path of [paths.profiles, paths.work, paths.run])
      inventory.set(path, await names(path, signal));
    const receipts: Awaited<ReturnType<typeof readReceipt>>[] = [];
    for (const name of inventory.get(paths.profiles) ?? []) {
      if (!/^\.retired-[a-f0-9]{32}\.json$/.test(name)) continue;
      if (receipts.length === 1024) throw failure();
      const receipt = await readReceipt(join(paths.profiles, name), name, signal);
      for (const key of ["home", "root", "profiles", "work", "run"] as const) {
        const parent = parents.get(paths[key]);
        if (!parent || !matches(parent, receipt.record.parents[key])) throw failure();
      }
      receipts.push(receipt);
    }
    const claimed = new Set<string>(),
      claimedIdentities = new Set<string>(),
      resources = new Map<(typeof receipts)[number], Resource[]>();
    for (const receipt of receipts) {
      const owned: Resource[] = [];
      for (const [parent, entry] of [
        [paths.work, receipt.record.work],
        [paths.run, receipt.record.bridge],
        [paths.profiles, receipt.record.profile],
      ] as const) {
        if (!entry) continue;
        const path = join(parent, entry.name),
          physical = `${parent}:${entry.identity.dev}:${entry.identity.ino}:${entry.identity.birthtimeNs}`;
        if (claimed.has(path) || claimedIdentities.has(physical)) throw failure();
        claimed.add(path);
        claimedIdentities.add(physical);
        const resource = { path, parent, identity: entry.identity };
        await present(resource);
        owned.push(resource);
      }
      resources.set(receipt, owned);
    }
    const files = new Set(receipts.map((r) => r.path));
    for (const [parent, entries] of inventory)
      for (const name of entries)
        if (!claimed.has(join(parent, name)) && !files.has(join(parent, name))) throw failure();
    await recheckParents(true);
    const recheckReceipt = async (receipt: (typeof receipts)[number]) => {
      const now = await lstat(receipt.path, { bigint: true });
      privateFile(now);
      if (!stable(receipt.stat, now)) throw failure();
    };
    const persist = async (path: string) => {
      await recheckParents(false);
      const fd = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const before = parents.get(path),
          opened = await fd.stat({ bigint: true });
        if (!before || !same(before, opened) || !opened.isDirectory()) throw failure();
        await fd.sync();
        await recheckParents(false);
      } finally {
        await fd.close();
      }
    };
    for (const receipt of receipts) {
      for (const resource of resources.get(receipt) ?? []) {
        await recheckParents(false);
        await recheckReceipt(receipt);
        if (await present(resource)) await rm(resource.path, { recursive: true });
        await persist(resource.parent);
        if (await present(resource)) throw failure();
      }
      // Persist every resource's removal before deleting the only durable retirement evidence.
      await persist(root);
      await persist(home);
      await recheckReceipt(receipt);
      for (const resource of resources.get(receipt) ?? [])
        if (await present(resource)) throw failure();
      signal.throwIfAborted();
      await unlink(receipt.path);
      await persist(paths.profiles);
      await persist(root);
      await persist(home);
    }
    await recheckParents(false);
    for (const path of inventory.keys()) if ((await names(path, signal)).length) throw failure();
    await recheckParents(false);
  } catch {
    throw failure();
  }
}
