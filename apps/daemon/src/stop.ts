import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { ComputerOperation, StopAllOutcome, StopOutcome, ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
export interface StopOptions {
  home: string;
  cellId?: string;
  // Every task, routine and computer at once.
  all?: boolean;
  signal: AbortSignal;
  port?: number;
}
export interface StopIO {
  out(message: string): void;
  err(message: string): void;
  fetch?: typeof fetch;
}
function tokenAt(home: string): string {
  if (!isAbsolute(home)) throw new Error("Invalid home");
  const root = lstatSync(home),
    uid = process.getuid?.();
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (root.mode & 0o077) !== 0 ||
    (uid !== undefined && root.uid !== uid)
  )
    throw new Error("Private home required");
  const file = join(realpathSync(home), "daemon-token"),
    before = lstatSync(file);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    (before.mode & 0o077) !== 0 ||
    before.nlink !== 1 ||
    before.size > 1024 ||
    (uid !== undefined && before.uid !== uid)
  )
    throw new Error("Private token required");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = fstatSync(fd);
    if (
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      !actual.isFile() ||
      actual.nlink !== 1 ||
      (actual.mode & 0o077) !== 0 ||
      actual.size > 1024 ||
      (uid !== undefined && actual.uid !== uid)
    )
      throw new Error("Token changed");
    const value = readFileSync(fd, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{32,512}$/.test(value)) throw new Error("Invalid token");
    return value;
  } finally {
    closeSync(fd);
  }
}
async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then((value) => {
        if (signal.aborted) reject(new Error("Interrupted"));
        else resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
const Cell = z.strictObject({
  id: z.string().regex(ULID_PATTERN),
  state: z.enum(["starting", "ready", "stopping", "stopped", "failed", "removed"]),
  scale: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.string().max(64),
  stream: z.strictObject({
    connection: z.enum(["none", "connecting", "live", "stalled", "disconnected"]),
    viewers: z.number().int().nonnegative(),
    lastUpstreamAt: z.number().nonnegative().nullable(),
  }),
  error: z.string().max(2048).optional(),
  paused: z.literal(true).optional(),
  fenced: z
    .strictObject({ revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
    .optional(),
  replacementPending: z.literal(true).optional(),
  updateAvailable: z.literal(true).optional(),
  updating: z.literal(true).optional(),
  needsFreshStart: z.literal(true).optional(),
  operation: ComputerOperation.optional(),
});
export async function runStop(options: StopOptions, io: StopIO): Promise<number> {
  const { home, cellId, signal } = options,
    port = options.port ?? 4750;
  let token: string;
  try {
    signal.throwIfAborted();
    if (cellId !== undefined && !ULID_PATTERN.test(cellId)) throw new Error("Invalid computer id");
    if (options.all && cellId !== undefined) throw new Error("Choose --all or --cell");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
    token = tokenAt(home);
  } catch {
    io.err("Stop could not start. Check the private installation home and computer ID.");
    return signal.aborted ? 130 : 1;
  }
  const lifetime = new AbortController(),
    timer = setTimeout(() => lifetime.abort(), 35000);
  const owned = AbortSignal.any([signal, lifetime.signal]);
  const fetchImpl = io.fetch ?? fetch;
  const request = async (path: string, status: number, method: "GET" | "POST" = "GET") => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => void reader?.cancel().catch(() => {});
    owned.addEventListener("abort", cancel, { once: true });
    try {
      const response = await wait(
        fetchImpl(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}` },
          signal: owned,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        }),
        owned,
      );
      if (response.status !== status) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Request unconfirmed");
      }
      const length = response.headers.get("content-length"),
        limit = 262144;
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Reply too large");
      }
      reader = response.body?.getReader();
      let size = 0,
        text = "";
      const decoder = new TextDecoder("utf8", { fatal: true });
      if (reader)
        for (;;) {
          const part = await wait(reader.read(), owned);
          owned.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > limit) throw new Error("Reply too large");
          text += decoder.decode(part.value, { stream: true });
        }
      text += decoder.decode();
      if (length !== null && Number(length) !== size) throw new Error("Incomplete reply");
      owned.throwIfAborted();
      return JSON.parse(text) as unknown;
    } finally {
      owned.removeEventListener("abort", cancel);
      cancel();
      reader?.releaseLock();
    }
  };
  try {
    if (options.all) {
      const outcome = StopAllOutcome.parse(await request("/api/stop-all?by=cli", 202, "POST"));
      owned.throwIfAborted();
      if (!outcome.confirmed) {
        io.err(
          "Stop everything is unconfirmed. Keep your computers unavailable and check their status before continuing.",
        );
        return 1;
      }
      const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
      io.out(
        `Everything stopped: ${count(outcome.sessions.length, "task", "tasks")} stopped, ${count(outcome.cells.length, "computer", "computers")} frozen, ${count(outcome.routinesPaused, "routine", "routines")} paused.`,
      );
      return 0;
    }
    const cells = z
      .array(Cell)
      .max(1024)
      .parse(await request("/api/cells", 200));
    if (new Set(cells.map((cell) => cell.id)).size !== cells.length)
      throw new Error("Duplicate computer");
    const available = cells.filter((cell) => cell.state === "ready" && !cell.replacementPending);
    if (!cellId && available.length > 1) {
      io.err("More than one computer is ready. Run Stop with --cell <computer-id>.");
      return 2;
    }
    const cell = cellId ? available.find((row) => row.id === cellId) : available[0];
    if (!cell) {
      io.err("No matching ready computer was verified. Stop is unconfirmed.");
      return 1;
    }
    const live = z
      .strictObject({ sessionId: z.string().regex(ULID_PATTERN) })
      .parse(await request(`/api/cells/${cell.id}/live`, 200));
    const outcome = StopOutcome.parse(
      await request(`/api/sessions/${live.sessionId}/stop`, 202, "POST"),
    );
    owned.throwIfAborted();
    if ((outcome.revoked && outcome.paused) || (outcome.closed && outcome.stopped)) {
      io.out(
        outcome.paused
          ? "Stop confirmed: the computer is paused and its key access is revoked."
          : "Stop confirmed: the computer is stopped and its key listener is closed.",
      );
      return 0;
    }
    io.err(
      "Stop is unconfirmed. Keep the computer unavailable and check its status before continuing.",
    );
    return 1;
  } catch {
    io.err(
      signal.aborted
        ? "Stop was interrupted; completion is unconfirmed."
        : "Stop could not be verified. Check the daemon and retry Stop explicitly.",
    );
    return signal.aborted ? 130 : 1;
  } finally {
    clearTimeout(timer);
    lifetime.abort();
  }
}
