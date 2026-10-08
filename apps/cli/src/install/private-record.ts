import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

const MAX_BYTES = 16 * 1024;
const unsafe = () => new Error("Installation recovery record is unavailable or unsafe.");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** The installer owns this existing 0700 directory and holds its exclusive install lock.
 * No directory creation, stale-lock breaking, service effects or journal deletion occurs here.
 * Other processes of the same user remain outside the filesystem isolation boundary.
 */
export function privateRecordStore<T>(
  directory: string,
  name: string,
  schema: { parse(value: unknown): T },
) {
  if (!/^[a-z][a-z-]*\.json$/.test(name)) throw unsafe();
  const file = join(directory, name);
  async function checkDirectory() {
    if (!isAbsolute(directory) || normalize(directory) !== directory || directory === "/")
      throw unsafe();
    const stat = await lstat(directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (stat.mode & 0o7777n) !== 0o700n ||
      (await realpath(directory)) !== directory
    )
      throw unsafe();
    return stat;
  }
  async function read(): Promise<T | null> {
    await checkDirectory();
    let handle: FileHandle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missing(error)) return null;
      throw unsafe();
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(MAX_BYTES) ||
        before.uid !== BigInt(process.getuid?.() ?? -1) ||
        (before.mode & 0o7777n) !== 0o600n
      )
        throw unsafe();
      const body = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < body.length) {
        const result = await handle.read(body, offset, body.length - offset, offset);
        if (!result.bytesRead) throw unsafe();
        offset += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const named = await lstat(file, { bigint: true });
      if (
        [after, named].some(
          (s) =>
            s.dev !== before.dev ||
            s.ino !== before.ino ||
            s.size !== before.size ||
            s.mtimeNs !== before.mtimeNs ||
            s.ctimeNs !== before.ctimeNs ||
            s.mode !== before.mode ||
            s.nlink !== 1n,
        )
      )
        throw unsafe();
      return schema.parse(JSON.parse(body.toString("utf8")));
    } catch {
      throw unsafe();
    } finally {
      await handle.close();
    }
  }
  async function save(input: T): Promise<void> {
    const body = `${JSON.stringify(schema.parse(input))}\n`;
    if (Buffer.byteLength(body) > MAX_BYTES) throw unsafe();
    const before = await checkDirectory();
    await read(); // Refuse to replace an unsafe/corrupt existing recovery record.
    const temporary = join(directory, `.record-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let moved = false;
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      const after = await checkDirectory();
      if (before.dev !== after.dev || before.ino !== after.ino) throw unsafe();
      await rename(temporary, file);
      moved = true;
      const parent = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await parent.stat({ bigint: true });
        if (before.dev !== stat.dev || before.ino !== stat.ino) throw unsafe();
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await handle.close();
      if (!moved)
        await unlink(temporary).catch((error) => {
          if (!missing(error)) throw error;
        });
    }
  }
  return { read, save };
}
