import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import {
  DesktopUploadFile,
  DesktopUploadPath,
} from "../../../../../packages/protocol/src/desktop-uploads.ts";
import { safeDownloadName, UPLOAD_BYTES } from "../../../../../packages/protocol/src/quarantine.ts";
import { FileToolError } from "./files.ts";

const CHUNK = 65536;
interface Entry {
  readonly handle: FileHandle;
  readonly stat: BigIntStats;
  readonly path: string;
}
interface Source {
  readonly path: string;
  readonly file: Entry;
  readonly identity: string;
  check(): Promise<void>;
  close(): Promise<void>;
}

function changed(): FileToolError {
  return new FileToolError(409, "The approved upload source changed or cannot be read safely.");
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return (
    same(a, b) &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function fingerprint(path: string, entries: readonly Entry[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        path,
        entries: entries.map(({ stat }, i) =>
          (i === entries.length - 1
            ? [
                stat.dev,
                stat.ino,
                stat.mode,
                stat.uid,
                stat.gid,
                stat.nlink,
                stat.size,
                stat.mtimeNs,
                stat.ctimeNs,
              ]
            : [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid]
          ).map(String),
        ),
      }),
    )
    .digest("hex");
}

async function openSource(home: string, raw: string, signal: AbortSignal): Promise<Source> {
  signal.throwIfAborted();
  if (
    process.platform !== "linux" ||
    !isAbsolute(home) ||
    normalize(home) !== home ||
    home === "/" ||
    home.endsWith("/")
  )
    throw changed();
  if (!DesktopUploadPath.safeParse(raw).success)
    throw new FileToolError(400, "Invalid upload path.");
  let tail = raw.startsWith("~/") ? raw.slice(2) : raw;
  if (isAbsolute(tail)) {
    if (!tail.startsWith(`${home}/`))
      throw new FileToolError(400, "Upload source must be inside the desktop home.");
    tail = tail.slice(home.length + 1);
  }
  const parts = tail.split("/").filter((part) => part !== "" && part !== ".");
  if (!parts.length || parts.length > 64 || parts.some((part) => part === ".." || part === "~"))
    throw new FileToolError(400, "Invalid upload path.");
  const path = `~/${parts.join("/")}`;
  const entries: Entry[] = [];
  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= (async () => {
      const results = await Promise.allSettled(entries.map((entry) => entry.handle.close()));
      if (results.some((result) => result.status === "rejected")) throw changed();
    })();
    return closed;
  };
  try {
    let current = home;
    for (let i = -1; i < parts.length; i++) {
      signal.throwIfAborted();
      const directory = i < parts.length - 1;
      const handle = await open(
        current,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (directory ? constants.O_DIRECTORY : 0),
      );
      let stat: BigIntStats;
      try {
        stat = await handle.stat({ bigint: true });
      } catch (error) {
        await handle.close();
        throw error;
      }
      entries.push({ handle, stat, path: current });
      if (
        !same(stat, await lstat(current, { bigint: true })) ||
        (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
      )
        throw changed();
      if (!directory && stat.size > BigInt(UPLOAD_BYTES))
        throw new FileToolError(413, "Upload source exceeds100MiB.");
      current = `/proc/self/fd/${handle.fd}/${parts[i + 1] ?? ""}`;
    }
    const file = entries.at(-1);
    if (!file) throw changed();
    const check = async () => {
      signal.throwIfAborted();
      for (const entry of entries) {
        const current = await entry.handle.stat({ bigint: true });
        const named = await lstat(entry.path, { bigint: true });
        if (
          entry === file
            ? !current.isFile() ||
              current.nlink !== 1n ||
              !unchanged(entry.stat, current) ||
              !unchanged(current, named)
            : !current.isDirectory() ||
              !same(entry.stat, current) ||
              !same(current, named) ||
              !named.isDirectory() ||
              current.mode !== entry.stat.mode ||
              current.uid !== entry.stat.uid ||
              current.gid !== entry.stat.gid
        )
          throw changed();
      }
      signal.throwIfAborted();
    };
    await check();
    return { path, file, identity: fingerprint(path, entries), check, close };
  } catch (error) {
    await close();
    if (signal.aborted) signal.throwIfAborted();
    throw error instanceof FileToolError ? error : changed();
  }
}

export async function inspectUploadSource(
  home: string,
  path: string,
  signal: AbortSignal,
): Promise<DesktopUploadFile> {
  const source = await openSource(home, path, signal);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(CHUNK);
    const bytes = Number(source.file.stat.size);
    let offset = 0;
    while (offset < bytes) {
      signal.throwIfAborted();
      const { bytesRead } = await source.file.handle.read(
        buffer,
        0,
        Math.min(CHUNK, bytes - offset),
        offset,
      );
      if (!bytesRead) throw changed();
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await source.check();
    return DesktopUploadFile.parse({
      path: source.path,
      name: safeDownloadName(source.path.split("/").at(-1) ?? "upload"),
      bytes,
      sha256: hash.digest("hex"),
      identity: source.identity,
    });
  } finally {
    await source.close();
  }
}

export async function readUploadSource(
  home: string,
  raw: DesktopUploadFile,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const expected = DesktopUploadFile.parse(raw);
  const source = await openSource(home, expected.path, signal);
  try {
    if (
      source.identity !== expected.identity ||
      Number(source.file.stat.size) !== expected.bytes ||
      safeDownloadName(source.path.split("/").at(-1) ?? "upload") !== expected.name
    )
      throw changed();
  } catch (error) {
    await source.close();
    throw error;
  }
  const local = new AbortController();
  const current = AbortSignal.any([signal, local.signal]);
  const iterator = (async function* () {
    try {
      let offset = 0;
      const hash = createHash("sha256");
      while (offset < expected.bytes) {
        current.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(CHUNK, expected.bytes - offset));
        const { bytesRead } = await source.file.handle.read(buffer, 0, buffer.length, offset);
        current.throwIfAborted();
        if (!bytesRead) throw changed();
        const bytes = buffer.subarray(0, bytesRead);
        hash.update(bytes);
        offset += bytesRead;
        yield bytes;
      }
      current.throwIfAborted();
      if (hash.digest("hex") !== expected.sha256) throw changed();
      await source.check();
      current.throwIfAborted();
    } finally {
      await source.close();
    }
  })();
  let ended = false;
  let retirement: Promise<void> | undefined;
  const retire = () => {
    local.abort();
    retirement ??= (async () => {
      await iterator.return(undefined);
      await source.close();
    })();
    return retirement;
  };
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const abort = () => {
    if (ended) return;
    ended = true;
    void retire().then(
      () => controller.error(signal.reason),
      (error: unknown) => controller.error(error),
    );
  };
  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(c) {
        try {
          const next = await iterator.next();
          if (ended) return;
          if (next.done) {
            ended = true;
            signal.removeEventListener("abort", abort);
            c.close();
          } else c.enqueue(next.value);
        } catch (error) {
          if (ended) return;
          ended = true;
          signal.removeEventListener("abort", abort);
          await retire();
          c.error(error);
        }
      },
      async cancel() {
        ended = true;
        signal.removeEventListener("abort", abort);
        await retire();
      },
    },
    { highWaterMark: 0 },
  );
}
