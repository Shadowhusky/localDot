import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
  type AppUpdateProgress,
  UpdateProgressLine,
} from "../../../../packages/protocol/src/app-update.ts";

// Each step's slice of the whole update. Install and restart share the last 5%.
const SLICES = { download: [0, 0.1], verify: [0.1, 0.15], images: [0.15, 0.95] } as const;
export const READY_SHARE = SLICES.images[1];
const MAX_LINE = 1024;
const MAX_PARSED = 16 * 1024 * 1024;

function amount(done: number, total: number) {
  return total >= 1e9
    ? `${(done / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB`
    : `${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB`;
}

function detail(line: UpdateProgressLine) {
  const bytes =
    line.total && line.done !== undefined
      ? ` · ${amount(Math.min(line.done, line.total), line.total)}`
      : "";
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
}

/** Runs a preparing updater with a progress channel on descriptor 3. Cancelling ends it with
 * SIGTERM, then SIGKILL. Resolves only when it exits 0 and was not cancelled. */
export function runPreparation(
  start: typeof spawn,
  { command, args, env, output, timeoutMs }: Preparation,
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
    const progress = child.stdio[3] as Readable | null | undefined;
    const drained = progress ? readUpdateProgress(progress, report).catch(() => {}) : undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(kill);
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
        finish(code === 0 && !signal.aborted ? undefined : new Error("Update preparation failed")),
      );
    });
  });
}
