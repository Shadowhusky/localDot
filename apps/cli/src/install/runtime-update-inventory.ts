import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  parseRuntimeUpdateJournal,
  type RuntimeUpdateJournal,
} from "../../../daemon/src/cells/runtime-update-store.ts";
import { privateDirectory } from "./copy-inventory.ts";

const failure = () => new Error("Computer update recovery inventory is unavailable.");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Read-only counterpart to the daemon's private journal. Never creates or repairs directories. */
export async function readRuntimeUpdateInventory(home: string): Promise<RuntimeUpdateJournal[]> {
  try {
    await privateDirectory(home);
    let dir = home;
    for (const name of ["safety", "computer-updates"]) {
      dir = join(dir, name);
      try {
        await lstat(dir);
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      await privateDirectory(dir);
    }
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.length > 1024) throw failure();
    const result: RuntimeUpdateJournal[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const temporary = /^\.record-[0-9A-HJKMNP-TV-Z]{26}\.tmp$/.test(entry.name);
      const match = /^([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(entry.name);
      if (!entry.isFile() || (!temporary && !match)) throw failure();
      const path = join(dir, entry.name),
        parent = await privateDirectory(dir);
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await file.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.uid !== BigInt(process.getuid?.() ?? -1) ||
          (before.mode & 0o7777n) !== 0o600n ||
          before.size > 8192n
        )
          throw failure();
        const bytes = Buffer.alloc(Number(before.size));
        let count = 0;
        while (count < bytes.length) {
          const read = await file.read(bytes, count, bytes.length - count, count);
          if (!read.bytesRead) throw failure();
          count += read.bytesRead;
        }
        const after = await file.stat({ bigint: true }),
          named = await lstat(path, { bigint: true }),
          currentParent = await privateDirectory(dir);
        if (
          parent.ino !== currentParent.ino ||
          parent.dev !== currentParent.dev ||
          [after, named].some(
            (stat) =>
              stat.ino !== before.ino ||
              stat.dev !== before.dev ||
              stat.nlink !== 1n ||
              stat.mode !== before.mode ||
              stat.uid !== before.uid ||
              stat.size !== before.size ||
              stat.mtimeNs !== before.mtimeNs ||
              stat.ctimeNs !== before.ctimeNs,
          )
        )
          throw failure();
        if (temporary) continue;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          raw: unknown = JSON.parse(text);
        if (`${JSON.stringify(raw)}\n` !== text) throw failure();
        const record = parseRuntimeUpdateJournal(raw);
        if (record.source.id !== match?.[1]) throw failure();
        result.push(record);
      } finally {
        await file.close();
      }
    }
    return result;
  } catch {
    throw failure();
  }
}
