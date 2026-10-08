import type { BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "./copy-inventory.ts";

const failure = () => new Error("Native task retirement could not be confirmed.");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const unchanged = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Requires exclusive daemon/keyd lifetime leases and the install mutex. Never removes leftovers
 * or signals remembered PIDs. The launcher persists its protected profile before spawn and only
 * removes it after confirmed retirement. Work/bridge leftovers also keep recovery unconfirmed.
 * This checks localDot's managed harness only; it does not inspect the user's own Codex home. */
export async function assertNativeRetired(home: string, signal: AbortSignal): Promise<void> {
  try {
    signal.throwIfAborted();
    const anchor = await privateDirectory(home),
      root = join(home, "codex");
    try {
      await lstat(root);
    } catch (error) {
      if (!missing(error)) throw error;
      if (!unchanged(anchor, await privateDirectory(home))) throw failure();
      signal.throwIfAborted();
      return;
    }
    const parent = await privateDirectory(root);
    const inspected: Array<{ path: string; stat: BigIntStats }> = [];
    for (const name of ["profiles", "work", "run"]) {
      signal.throwIfAborted();
      const path = join(root, name),
        stat = await privateDirectory(path);
      // Read only one entry: any retained resource is uncertainty, regardless of its filename.
      const dir = await opendir(path);
      try {
        if ((await dir.read()) !== null) throw failure();
      } finally {
        await dir.close();
      }
      inspected.push({ path, stat });
    }
    for (const { path, stat } of inspected)
      if (!unchanged(stat, await privateDirectory(path))) throw failure();
    if (
      !unchanged(parent, await privateDirectory(root)) ||
      !unchanged(anchor, await privateDirectory(home))
    )
      throw failure();
    signal.throwIfAborted();
  } catch {
    throw failure();
  }
}
