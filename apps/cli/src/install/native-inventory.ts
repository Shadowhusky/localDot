import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "./copy-inventory.ts";
import type { ExtractedFile } from "./extract-release.ts";

const fail = () =>
  new Error("Installed native dependency files do not match their verified archives.");

export async function verifyNativeInventory(
  root: string,
  files: Readonly<Record<string, ExtractedFile>>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const expected = new Map(Object.entries(files).map(([path, item]) => [path, { ...item }]));
  if (!expected.size || expected.size > 32768) throw fail();
  for (const [path, item] of expected)
    if (
      path.length > 1024 ||
      path.split("/").length > 20 ||
      !/^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*$/.test(path) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > 64 * 1024 * 1024 ||
      ![0o600, 0o700].includes(item.mode) ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    )
      throw fail();
  await privateDirectory(root);
  let entries = 0,
    total = 0;
  const seen = new Set<string>();
  async function walk(directory: string, prefix: string): Promise<number> {
    await privateDirectory(directory);
    const names = (await readdir(directory)).sort();
    let count = 0;
    for (const name of names) {
      signal.throwIfAborted();
      const path = prefix + name,
        absolute = join(directory, name);
      if (++entries > 65536 || seen.has(path.toLowerCase())) throw fail();
      seen.add(path.toLowerCase());
      const st = await lstat(absolute, { bigint: true });
      if (st.isDirectory()) {
        const nested = await walk(absolute, `${path}/`);
        if (!nested) throw fail();
        count += nested;
        continue;
      }
      const item = expected.get(path);
      if (
        !item ||
        !st.isFile() ||
        st.nlink !== 1n ||
        st.uid !== BigInt(process.getuid?.() ?? -1) ||
        st.size !== BigInt(item.bytes) ||
        st.size > 64n * 1024n * 1024n ||
        (st.mode & 0o7777n) !== BigInt(item.mode)
      )
        throw fail();
      total += item.bytes;
      if (total > 512 * 1024 * 1024) throw fail();
      const file = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const buffer = Buffer.alloc(65536),
          hash = createHash("sha256");
        let offset = 0;
        while (offset < item.bytes) {
          signal.throwIfAborted();
          const r = await file.read(
            buffer,
            0,
            Math.min(buffer.length, item.bytes - offset),
            offset,
          );
          if (!r.bytesRead) throw fail();
          hash.update(buffer.subarray(0, r.bytesRead));
          offset += r.bytesRead;
        }
        for (const actual of [
          await file.stat({ bigint: true }),
          await lstat(absolute, { bigint: true }),
        ])
          if (
            actual.ino !== st.ino ||
            actual.dev !== st.dev ||
            actual.size !== st.size ||
            actual.mtimeNs !== st.mtimeNs ||
            actual.ctimeNs !== st.ctimeNs ||
            actual.mode !== st.mode ||
            actual.nlink !== 1n
          )
            throw fail();
        if (hash.digest("hex") !== item.sha256) throw fail();
      } finally {
        await file.close();
      }
      expected.delete(path);
      count++;
    }
    if (JSON.stringify(names) !== JSON.stringify((await readdir(directory)).sort())) throw fail();
    return count;
  }
  await walk(root, "");
  if (expected.size) throw fail();
  signal.throwIfAborted();
}
