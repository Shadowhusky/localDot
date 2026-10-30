import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ShellChunk, ShellDone } from "@localdot/protocol";
import { desktopMemoryNow } from "./memory.ts";

export interface ShellOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  // A login shell sources /etc/profile.d, including the cell's keyd surrogates.
  shell?: string;
  // The command's own process session, which its programs' windows carry.
  onSpawn?(pid: number): void;
}

// The caller can freeze the cell on uncertain cleanup. Signalling this UID's process group alone
// cannot contain elevated children or descendants that deliberately create a new session.
export class ShellTerminationError extends Error {
  constructor(
    readonly groupPid: number,
    cause: unknown,
  ) {
    super("could not confirm termination of the shell process group", { cause });
    this.name = "ShellTerminationError";
  }
}

const PRIVATE_ENV = /^(LOCALDOT_DESKTOPD_|PASSWORD$|CUSTOM_USER$|LOCALDOT_SCALE$)/;
const PIPE_DRAIN_MS = 250;

export function shellEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!PRIVATE_ENV.test(key)) out[key] = value;
  out.HOME = home;
  out.TERM = "dumb";
  out.PAGER = "cat";
  out.GIT_PAGER = "cat";
  out.DEBIAN_FRONTEND = "noninteractive";
  return out;
}

// Each command owns a process group. Stop, timeout and the output cap kill that group. Successful
// foreground exit preserves background jobs; their inherited pipes get only a bounded drain.
async function executeShell(
  opts: ShellOptions,
  onChunk: (chunk: ShellChunk) => void,
): Promise<ShellDone> {
  opts.signal?.throwIfAborted();
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > 600_000) {
    throw new RangeError("timeoutMs must be an integer from 1 to 600000");
  }
  if (
    !Number.isSafeInteger(opts.maxOutputBytes) ||
    opts.maxOutputBytes < 1 ||
    opts.maxOutputBytes > 4 * 1024 * 1024
  ) {
    throw new RangeError("maxOutputBytes must be an integer from 1 to 4194304");
  }
  const started = performance.now();
  const child = spawn(opts.shell ?? "/bin/bash", ["-l", "-c", opts.command], {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid) opts.onSpawn?.(child.pid);

  return new Promise<ShellDone>((resolveDone, reject) => {
    let settled = false;
    let hasFailure = false;
    let failure: unknown;
    let failedKill = false;
    let killError: unknown;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let inputBytes = 0;
    let outputBytes = 0;
    let timedOut = false;
    let truncated = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };

    const fail = (error: unknown) => {
      if (!hasFailure) failure = error;
      hasFailure = true;
    };

    const killGroup = () => {
      if (settled || !child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
        failedKill = false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          failedKill = true;
          killError = error;
          // Stop the foreground too if group signalling was refused. Completion below must still
          // report a surviving/inaccessible group; this fallback never claims group termination.
          try {
            child.kill("SIGKILL");
          } catch (foregroundError) {
            fail(foregroundError);
          }
        }
      }
    };
    const emit = (stream: "stdout" | "stderr", text: string) => {
      if (!text) return;
      const available = opts.maxOutputBytes - outputBytes;
      const encoded = Buffer.from(text);
      if (encoded.length > available) {
        // Invalid input can expand to replacement characters. Bound the emitted UTF-8 bytes too,
        // and omit an incomplete final character rather than exceeding the cap when flushing.
        text = new StringDecoder("utf8").write(encoded.subarray(0, available));
        truncated = true;
        killGroup();
      }
      // child.kill can emit error synchronously and finish the call during killGroup.
      if (settled) return;
      outputBytes += Buffer.byteLength(text);
      if (text) onChunk({ stream, chunk: text });
    };
    const finish = () => {
      if (settled) return;
      try {
        if (!hasFailure && !truncated) {
          for (const stream of ["stdout", "stderr"] as const) {
            if (!truncated) emit(stream, decoders[stream].end());
          }
        }
      } catch (error) {
        fail(error);
        killGroup();
      }
      // A synchronous child error may have completed a nested finish while flushing.
      if (settled) return;
      if (failedKill && child.pid) {
        // macOS can report EPERM for a group containing only the unreaped, already-exited shell.
        // Verify disappearance after exit; never silently swallow a persistent permissions error.
        try {
          process.kill(-child.pid, 0);
          failure = new ShellTerminationError(child.pid, killError);
          hasFailure = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            failure = new ShellTerminationError(child.pid, killError);
            hasFailure = true;
          }
        }
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      if (hasFailure) reject(failure);
      else if (exit) {
        resolveDone({
          done: true,
          exitCode: exit.code,
          signal: exit.signal,
          timedOut,
          truncated,
          ms: Math.round(performance.now() - started),
        });
      }
    };
    const forward = (stream: "stdout" | "stderr") => (data: Buffer) => {
      if (settled || truncated || hasFailure) return;
      const available = opts.maxOutputBytes - inputBytes;
      const piece = data.subarray(0, available);
      inputBytes += piece.length;
      try {
        emit(stream, decoders[stream].write(piece));
      } catch (error) {
        fail(error);
        killGroup();
      }
      if (data.length > available) {
        truncated = true;
        killGroup();
      }
    };
    const onAbort = () => killGroup();
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    child.stdout.on("data", forward("stdout"));
    child.stderr.on("data", forward("stderr"));
    const onPipeError = (error: Error) => {
      if (settled) return;
      fail(error);
      killGroup();
    };
    child.stdout.on("error", onPipeError);
    child.stderr.on("error", onPipeError);
    child.once("error", (error) => {
      if (settled) return;
      fail(error);
      finish();
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      exit = { code, signal };
      clearTimeout(timer);
      drainTimer = setTimeout(finish, PIPE_DRAIN_MS);
    });
    child.once("close", () => {
      if (exit) finish();
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // An abort can happen synchronously during spawn (e.g. a custom signal/spawn adapter).
    if (opts.signal?.aborted) onAbort();
  });
}

// Report pressure even after a successful command: an unrelated renderer may have been killed.
export async function runShell(
  opts: ShellOptions,
  onChunk: (chunk: ShellChunk) => void,
): Promise<ShellDone> {
  opts.signal?.throwIfAborted();
  const before = desktopMemoryNow();
  const done = await executeShell(opts, onChunk);
  const memory = desktopMemoryNow();
  return {
    ...done,
    ...(memory ? { memory } : {}),
    ...(before && memory && memory.oomKills >= before.oomKills
      ? { oomKillsDuringCommand: memory.oomKills - before.oomKills }
      : {}),
  };
}
