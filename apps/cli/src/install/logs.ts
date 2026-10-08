import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceOwner } from "../../../../packages/protocol/src/install-services.ts";
import { redactor } from "../../../daemon/src/agent/redact.ts";
import type { ConsoleIO, RuntimeContext } from "../runtime.ts";
import { privateDirectory } from "./copy-inventory.ts";
import { privateRecordStore } from "./private-record.ts";

const FILES = ["daemon.log", "daemon.error.log", "keyd.log", "keyd.error.log"] as const;
const WINDOW = 64 * 1024,
  MAX_LINE = 16 * 1024;
const redactSurrogates = redactor([]);
const unsafe = () => new Error("Service logs unavailable");
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Whole-line sanitization before terminal output. Producers must still avoid logging secrets. */
export function displayLogLine(raw: string): string {
  return redactSurrogates(raw)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/([#?&](?:code|token)=)[^\s"'<>]*/gi, "$1[redacted]")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) =>
      char === "\t" ? "  " : `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0")}`,
    );
}
type Cursor = { dev: bigint; ino: bigint; offset: number; pending: Buffer; discarding: boolean };
export type LogCursors = Partial<Record<(typeof FILES)[number], Cursor | null>>;

function checkFile(stat: BigIntStats, uid: number) {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(uid) ||
    (stat.mode & 0o7777n) !== 0o600n ||
    stat.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw unsafe();
}

/** Read-only snapshots: appends may continue, but a named replacement during a read is refused.
 * Rotation between polls reopens the newly validated file; no stale descriptor is followed.
 */
export async function readServiceLogs(
  home: string,
  previous: LogCursors,
  follow: boolean,
  signal: AbortSignal,
  expectedOwner?: string,
) {
  signal.throwIfAborted();
  const state = join(home, "install"),
    directory = join(state, "logs"),
    uid = process.getuid?.();
  if (!uid) throw unsafe();
  const homeStat = await privateDirectory(home),
    stateStat = await privateDirectory(state);
  const owner = await privateRecordStore(state, "service-owner.json", ServiceOwner).read();
  if (
    !owner ||
    owner.home !== home ||
    owner.state !== state ||
    owner.uid !== uid ||
    (expectedOwner !== undefined && owner.id !== expectedOwner)
  )
    throw unsafe();
  const directoryStat = await privateDirectory(directory),
    lines: string[] = [],
    cursors: LogCursors = {};
  for (const name of FILES) {
    signal.throwIfAborted();
    const file = join(directory, name),
      prefix = `[${name}] `;
    let fd: FileHandle;
    try {
      fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (!missing(error)) throw error;
      if (previous[name] !== null) lines.push(`${prefix}Log has not been created yet.`);
      cursors[name] = null;
      continue;
    }
    try {
      const before = await fd.stat({ bigint: true });
      checkFile(before, uid);
      const size = Number(before.size),
        old = previous[name];
      const reset = !old || old.dev !== before.dev || old.ino !== before.ino || size < old.offset;
      const from = reset ? Math.max(0, size - WINDOW) : Math.max(old.offset, size - WINDOW);
      const skipped = reset ? from > 0 : from > old.offset;
      const cursor: Cursor = {
        dev: before.dev,
        ino: before.ino,
        offset: size,
        pending: reset || skipped ? Buffer.alloc(0) : old.pending,
        discarding: skipped || (!reset && old.discarding),
      };
      if (reset && old) lines.push(`${prefix}Log rotated or truncated.`);
      if (skipped) lines.push(`${prefix}Older output omitted (read window limit).`);
      const body = Buffer.alloc(size - from);
      let offset = 0;
      while (offset < body.length) {
        signal.throwIfAborted();
        const result = await fd.read(body, offset, body.length - offset, from + offset);
        if (!result.bytesRead) throw unsafe();
        offset += result.bytesRead;
      }
      const named = await lstat(file, { bigint: true }),
        after = await fd.stat({ bigint: true });
      for (const stat of [after, named]) {
        checkFile(stat, uid);
        if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size < before.size)
          throw unsafe();
      }
      const batch: string[] = [];
      for (let start = 0; start < body.length; ) {
        const newline = body.indexOf(10, start),
          end = newline === -1 ? body.length : newline;
        if (!cursor.discarding) {
          if (cursor.pending.length + end - start > MAX_LINE) {
            batch.push("Oversized log line omitted.");
            cursor.pending = Buffer.alloc(0);
            cursor.discarding = true;
          } else cursor.pending = Buffer.concat([cursor.pending, body.subarray(start, end)]);
        }
        if (newline !== -1) {
          if (!cursor.discarding)
            batch.push(displayLogLine(cursor.pending.toString("utf8").replace(/\r$/, "")));
          cursor.pending = Buffer.alloc(0);
          cursor.discarding = false;
        }
        start = end + (newline === -1 ? 0 : 1);
      }
      if (!follow && !cursor.discarding && cursor.pending.length) {
        batch.push(displayLogLine(cursor.pending.toString("utf8")));
        cursor.pending = Buffer.alloc(0);
      }
      if (reset && batch.length > 100)
        lines.push(`${prefix}Older output omitted (100-line limit).`);
      lines.push(...(reset ? batch.slice(-100) : batch).map((line) => prefix + line));
      cursors[name] = cursor;
    } finally {
      await fd.close();
    }
  }
  for (const [path, before] of [
    [home, homeStat],
    [state, stateStat],
    [directory, directoryStat],
  ] as const) {
    const after = await privateDirectory(path);
    if (before.ino !== after.ino || before.dev !== after.dev) throw unsafe();
  }
  const currentOwner = await privateRecordStore(state, "service-owner.json", ServiceOwner).read();
  if (JSON.stringify(currentOwner) !== JSON.stringify(owner)) throw unsafe();
  signal.throwIfAborted();
  return { lines, cursors, owner: owner.id };
}

export async function runLogs(
  context: Pick<RuntimeContext, "home" | "signal"> & { follow: boolean },
  io: ConsoleIO,
): Promise<number> {
  let cursors: LogCursors = {},
    owner: string | undefined;
  try {
    do {
      const batch = await readServiceLogs(
        context.home,
        cursors,
        context.follow,
        context.signal,
        owner,
      );
      for (const line of batch.lines) {
        context.signal.throwIfAborted();
        io.out(line);
      }
      cursors = batch.cursors;
      owner = batch.owner;
      if (!context.follow) {
        if (!batch.lines.length) io.out("No service log entries yet.");
        return 0;
      }
      await delay(500, undefined, { signal: context.signal });
    } while (!context.signal.aborted);
    return 130;
  } catch {
    if (context.signal.aborted) return 130;
    io.err("Could not read managed service logs. Check the private installation directory.");
    return 1;
  }
}
