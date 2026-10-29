import { ULID_PATTERN } from "../../../packages/protocol/src/ids.ts";
import type { ComputerOperation } from "./args.ts";
import { terminalText } from "./chat.ts";
import { connect, fail, type LocalApi, LocalApiError, type LocalDot } from "./local-dot.ts";
import type { ConsoleIO } from "./runtime.ts";

export interface Computer {
  id: string;
  state: string;
  paused?: true;
  fenced?: true;
  updateAvailable?: true;
  error?: string;
  // The session of the task running on it.
  task?: string;
}

function computer(value: unknown): Computer | undefined {
  const row = value as Record<string, unknown> | null;
  if (typeof row?.id !== "string" || !ULID_PATTERN.test(row.id) || typeof row.state !== "string")
    return undefined;
  return {
    id: row.id,
    state: row.state,
    ...(row.paused === true ? { paused: true as const } : {}),
    ...(row.fenced || row.replacementPending ? { fenced: true as const } : {}),
    ...(row.updateAvailable === true ? { updateAvailable: true as const } : {}),
    ...(typeof row.error === "string" ? { error: terminalText(row.error).slice(0, 300) } : {}),
  };
}

export async function computers(api: LocalApi): Promise<Computer[]> {
  const rows = await api("GET", "/api/cells");
  if (!Array.isArray(rows)) throw new Error("Invalid computer list");
  const list = rows.flatMap((row) => computer(row) ?? []).filter((c) => c.state !== "removed");
  return Promise.all(
    list.map(async (c) => {
      if (c.state !== "ready") return c;
      const live = await api<{ sessionId?: unknown } | undefined>(
        "GET",
        `/api/cells/${c.id}/live`,
      ).catch(() => undefined);
      return typeof live?.sessionId === "string" ? { ...c, task: live.sessionId } : c;
    }),
  );
}

export function describeComputer(c: Computer): string {
  return [
    c.paused ? "frozen (localdot computer resume)" : c.state,
    ...(c.fenced ? ["held for recovery"] : []),
    ...(c.task ? ["a task is running"] : []),
    ...(c.updateAvailable ? ["update available"] : []),
    ...(c.state === "failed" && c.error ? [c.error] : []),
  ].join(", ");
}

function pick(list: Computer[], l: LocalDot, cellId?: string): Computer {
  if (cellId)
    return (
      list.find((c) => c.id === cellId) ??
      fail(`There's no computer ${cellId} here. See: localdot computer list${l.dotFlag}`)
    );
  if (list.length === 1 && list[0]) return list[0];
  if (!list.length)
    fail(`There's no computer yet. Start one with: localdot computer start${l.dotFlag}`);
  return fail(
    [
      `There are ${list.length} computers. Choose one with --cell <id>:`,
      ...list.map((c) => `  ${c.id}  ${describeComputer(c)}`),
    ].join("\n"),
  );
}

const READY_MS = 5 * 60_000;
const STOPPED_MS = 2 * 60_000;
const NOTICE_MS = 15_000;

async function settle(
  l: LocalDot,
  api: LocalApi,
  io: ConsoleIO,
  id: string,
  want: "ready" | "stopped",
): Promise<void> {
  const started = l.now(),
    limit = want === "ready" ? READY_MS : STOPPED_MS;
  let notice = started + NOTICE_MS;
  for (;;) {
    const c = computer(await api("GET", `/api/cells/${id}`));
    if (!c) throw new Error("Invalid computer");
    if (c.state === want) return;
    if (c.state === "failed")
      fail(
        `Computer ${id} ${want === "ready" ? "couldn't start" : "couldn't stop"}${c.error ? `: ${c.error}` : "."} localdot doctor${l.dotFlag} checks Docker and the key service.`,
      );
    const waited = l.now() - started;
    if (waited >= limit)
      fail(
        `Computer ${id} is still ${c.state} after ${limit / 1000} seconds. Check it with localdot computer list${l.dotFlag}.`,
      );
    if (l.now() >= notice) {
      io.out(
        `Still ${want === "ready" ? "starting" : "stopping"} (${Math.round(waited / 1000)} s)…`,
      );
      notice += NOTICE_MS;
    }
    await l.sleep(2000);
  }
}

// A refusal from the app is shown as the app worded it.
async function act(api: LocalApi, path: string, what: string, body?: unknown) {
  try {
    return await api("POST", path, body, 120_000);
  } catch (error) {
    if (error instanceof LocalApiError) fail(`${what}: ${error.message}`);
    throw error;
  }
}

async function start(l: LocalDot, api: LocalApi, io: ConsoleIO, c: Computer): Promise<void> {
  io.out(`Starting computer ${c.id}…`);
  await act(api, `/api/cells/${c.id}/start`, `Computer ${c.id} couldn't start`);
  await settle(l, api, io, c.id, "ready");
  io.out(`Computer ${c.id} is running.`);
}

async function stop(l: LocalDot, api: LocalApi, io: ConsoleIO, c: Computer): Promise<void> {
  // Stopping the computer under a task would leave the task acting on nothing.
  if (c.task)
    fail(
      `A task is running on computer ${c.id}. Stop the task first with localdot stop --cell ${c.id}${l.dotFlag}, or let it finish.`,
    );
  io.out(`Stopping computer ${c.id}…`);
  await act(api, `/api/cells/${c.id}/stop`, `Computer ${c.id} couldn't stop`);
  await settle(l, api, io, c.id, "stopped");
  io.out(`Computer ${c.id} is stopped. Its files and apps are kept.`);
}

export async function runComputer(
  l: LocalDot,
  io: ConsoleIO,
  options: { operation: ComputerOperation; cellId?: string; json: boolean },
): Promise<number> {
  const api = await connect(l);
  const list = await computers(api);
  if (options.operation === "list") {
    if (options.json) io.out(JSON.stringify({ computers: list }));
    else if (!list.length)
      io.out(`There's no computer yet. Start one with: localdot computer start${l.dotFlag}`);
    else for (const c of list) io.out(`${c.id}  ${describeComputer(c)}`);
    return 0;
  }
  if (options.operation === "start" && !options.cellId && !list.length) {
    io.out("Creating a computer…");
    const made = computer(
      await act(api, "/api/cells", "A computer couldn't be created", { scale: 2 }),
    );
    if (!made) throw new Error("Invalid computer");
    await settle(l, api, io, made.id, "ready");
    io.out(`Computer ${made.id} is running.`);
    return 0;
  }
  const c = pick(list, l, options.cellId);
  switch (options.operation) {
    case "start":
      if (c.state === "ready") {
        io.out(
          c.paused
            ? `Computer ${c.id} is running but frozen. Resume it with: localdot computer resume --cell ${c.id}${l.dotFlag}`
            : `Computer ${c.id} is already running.`,
        );
        return 0;
      }
      await start(l, api, io, c);
      return 0;
    case "stop":
      if (c.state === "stopped") {
        io.out(`Computer ${c.id} is already stopped.`);
        return 0;
      }
      await stop(l, api, io, c);
      return 0;
    case "restart":
      if (c.state !== "stopped") await stop(l, api, io, c);
      await start(l, api, io, c);
      return 0;
    case "resume":
      if (!c.paused) {
        io.out(`Computer ${c.id} isn't frozen, so there's nothing to resume.`);
        return 0;
      }
      await act(api, `/api/cells/${c.id}/resume`, `Computer ${c.id} couldn't resume`);
      io.out(
        `Computer ${c.id} resumed with fresh key stand-ins. Open shells keep the old ones until they reload them.`,
      );
      return 0;
  }
}
