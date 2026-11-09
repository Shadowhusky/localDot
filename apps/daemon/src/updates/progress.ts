import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
  type AppUpdateProgress,
  type UpdateProblem,
  UpdateProgressLine,
} from "../../../../packages/protocol/src/app-update.ts";

// Each step's slice of the whole update. Install and restart share the last 5%.
const SLICES = { download: [0, 0.1], verify: [0.1, 0.15], images: [0.15, 0.95] } as const;
export const READY_SHARE = SLICES.images[1];
const MAX_LINE = 1024;
const MAX_PARSED = 16 * 1024 * 1024;

const REASONS: Partial<Record<UpdateProblem, string>> = {
  network: "Check your connection and try again.",
  stalled:
    "The download stopped moving. Check your connection and try again; it picks up where it stopped.",
  disk: "There isn't enough free disk space. Free some up and try again.",
  docker: "Docker isn't running. Start it and try again.",
  verify: "The download didn't match its signed release.",
  busy: "Another update is already running. Wait for it to finish.",
  channel: "A newer version came out a moment ago. Try again to get it.",
};

/** A failed update step that knows what went wrong. */
export class UpdateFailure extends Error {
  constructor(readonly problem: UpdateProblem) {
    super(`Update stopped: ${problem}`);
  }
  // The second sentence of what the user is told.
  get reason() {
    return REASONS[this.problem];
  }
}
export const reasonFor = (problem: UpdateProblem | undefined) =>
  problem ? REASONS[problem] : undefined;

const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

function amount(done: number, total: number) {
  return total >= 1e9
    ? `${(done / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB`
    : `${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB`;
}

export function downloadDetail(done: number | undefined, total: number | undefined) {
  if (done === undefined) return "Downloading";
  if (!total) return `Downloading · ${size(done)} so far`;
  const seen = Math.min(done, total);
  return `Downloading · ${Math.floor((seen / total) * 100)}% · ${amount(seen, total)}`;
}

function detail(line: UpdateProgressLine) {
  const share = line.share ?? (line.total ? Math.min(1, (line.done ?? 0) / line.total) : undefined);
  const percent = share !== undefined ? ` · ${Math.floor(share * 100)}%` : "";
  const bytes =
    line.total && line.done !== undefined
      ? `${percent} · ${amount(Math.min(line.done, line.total), line.total)}`
      : percent;
  if (line.step === "download") return `Downloading${bytes}`;
  if (line.step === "verify") return "Checking the download";
  return `Preparing the computer${bytes}`;
}

/** The whole update's progress after one line. A value never falls, and once the bar has a
 * length it keeps one. */
export function progressAfter(
  previous: AppUpdateProgress | null,
  line: UpdateProgressLine,
): AppUpdateProgress {
  const [from, to] = SLICES[line.step];
  const share = line.share ?? (line.total ? Math.min(1, (line.done ?? 0) / line.total) : undefined);
  let value: number | null =
    share !== undefined ? from + (to - from) * share : line.step === "download" ? null : from;
  if (previous?.value != null) value = Math.max(previous.value, value ?? 0);
  return {
    step: line.step,
    value: value === null ? null : Math.round(value * 1000) / 1000,
    detail: detail(line),
  };
}

/** Bounded newline-delimited JSON. Progress only informs: a line that is too long, malformed or
 * unknown is skipped, and the stream is always drained so the writer never blocks on it. */
export async function readUpdateProgress(
  stream: AsyncIterable<Buffer | string>,
  report: (line: UpdateProgressLine) => void,
) {
  const line = Buffer.alloc(MAX_LINE);
  let used = 0,
    overlong = false,
    parsed = 0;
  const consume = () => {
    if (!overlong && used && parsed < MAX_PARSED) {
      parsed += used;
      try {
        const value = UpdateProgressLine.safeParse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.subarray(0, used))),
        );
        if (value.success) report(value.data);
      } catch {}
    }
    used = 0;
    overlong = false;
  };
  for await (const input of stream) {
    const chunk = typeof input === "string" ? Buffer.from(input) : input;
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset),
        stop = end === -1 ? chunk.length : end;
      if (overlong || used + stop - offset > line.length) overlong = true;
      else used += chunk.copy(line, used, offset, stop);
      offset = stop + (end === -1 ? 0 : 1);
      if (end !== -1) consume();
    }
  }
  consume();
}

export interface Preparation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  // Where the child's own output goes: a log file's descriptor, or nowhere.
  output: number | "ignore";
  timeoutMs: number;
  // Ended, as stalled, once this long passes without a line of progress.
  stallMs?: number;
}

/** Runs work that calls touch() as it gets anywhere, cancelling it with a stall once it stops. */
export async function stallGuard<T>(
  signal: AbortSignal,
  stallMs: number,
  work: (signal: AbortSignal, touch: () => void) => Promise<T>,
): Promise<T> {
  const stalled = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stalled.abort(new UpdateFailure("stalled")), stallMs);
    timer.unref?.();
  };
  touch();
  try {
    return await work(AbortSignal.any([signal, stalled.signal]), touch);
  } catch (error) {
    throw stalled.signal.aborted ? stalled.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a preparing updater with a progress channel on descriptor 3. Cancelling ends it with
 * SIGTERM, then SIGKILL. Resolves only when it exits 0 and was not cancelled. */
export function runPreparation(
  start: typeof spawn,
  { command, args, env, output, timeoutMs, stallMs }: Preparation,
  signal: AbortSignal,
  report: (line: UpdateProgressLine) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const options: SpawnOptions = {
      cwd: "/",
      env: { ...env, LOCALDOT_PROGRESS_FD: "3" },
      stdio: ["ignore", output, output, "pipe"],
    };
    const child: ChildProcess = start(command, args, options);
    let kill: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      child.kill("SIGTERM");
      kill ??= setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
    };
    signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, timeoutMs).unref();
    if (signal.aborted) cancel();
    let problem: UpdateProblem | undefined;
    let silent: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      if (!stallMs) return;
      clearTimeout(silent);
      silent = setTimeout(() => {
        problem ??= "stalled";
        cancel();
      }, stallMs).unref();
    };
    heard();
    const progress = child.stdio[3] as Readable | null | undefined;
    const drained = progress
      ? readUpdateProgress(progress, (line) => {
          heard();
          problem = line.problem ?? problem;
          report(line);
        }).catch(() => {})
      : undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(kill);
      clearTimeout(silent);
      signal.removeEventListener("abort", cancel);
      progress?.destroy();
      if (error) reject(error);
      else resolve();
    };
    child.once("error", () => finish(new Error("The update couldn't start.")));
    // "exit", not "close": a process the updater started may still hold the channel open. Lines
    // written before the exit are read first, for at most a second.
    child.once("exit", (code) => {
      void Promise.race([drained, new Promise((done) => setTimeout(done, 1000).unref())]).then(() =>
        finish(
          code === 0 && !signal.aborted
            ? undefined
            : problem
              ? new UpdateFailure(problem)
              : new Error("Update preparation failed"),
        ),
      );
    });
  });
}
