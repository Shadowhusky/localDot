import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { NativeSupervision } from "./retirement-record.ts";
export type CodexProcessFailure =
  | "cancelled"
  | "process_startup_failed"
  | "process_transport_failed"
  | "process_shutdown_failed";
export class CodexProcessError extends Error {
  constructor(readonly code: CodexProcessFailure) {
    super(
      {
        cancelled: "The Codex process was cancelled.",
        process_startup_failed: "The Codex process could not be started.",
        process_transport_failed: "The Codex connection failed.",
        process_shutdown_failed: "The Codex process could not be stopped.",
      }[code],
    );
    this.name = "CodexProcessError";
  }
}
export interface CodexProcess {
  readonly pid: number | undefined;
  readonly stdin: Writable | undefined;
  readonly stdout: Readable | undefined;
  readonly stderr: Readable | undefined;
  readonly started: Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly closed: Promise<void>;
  readonly failure: Promise<CodexProcessError>;
  stop(): Promise<void>;
}
export interface SpawnCodexInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  // Trusted owner registers the retirement handle synchronously before any process is created.
  readonly register: (process: CodexProcess) => void;
  readonly fence?: () => void;
  readonly interrupt?: () => void | Promise<void>;
  readonly supervision?: NativeSupervision;
  // Internal test seams, never caller/model-controlled launch options.
  readonly spawnImpl?: typeof spawn;
  readonly killImpl?: (pid: number, signal: NodeJS.Signals | 0) => void;
}
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
// Internal primitive. Only the later owner-controlled launcher calls it in production; the
// public harness index exposes types/errors, not this arbitrary-command test seam.
export function spawnCodex(input: SpawnCodexInput): CodexProcess {
  const started = deferred<void>(),
    exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>(),
    closed = deferred<void>(),
    failure = deferred<CodexProcessError>();
  let child: ChildProcess | undefined,
    pid: number | undefined,
    allocating = false,
    spawned = false,
    exitSeen = false,
    closeSeen = false,
    groupGone = false,
    complete = false,
    stopping = false,
    signalFault = false,
    checking = false;
  let stopResult: ReturnType<typeof deferred<void>> | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let poll: ReturnType<typeof setInterval> | undefined;
  const pipes = new Map<Readable | Writable, boolean>();
  const disposers: Array<() => void> = [];
  let tail = Buffer.alloc(0);
  const fail = (code: CodexProcessFailure) => failure.resolve(new CodexProcessError(code));
  const rejectStart = (code: CodexProcessFailure) => {
    started.reject(new CodexProcessError(code));
    if (code !== "cancelled") fail(code);
  };
  const listen = (emitter: EventEmitter, event: string, handler: (...args: unknown[]) => void) => {
    emitter.on(event, handler);
    disposers.push(() => emitter.removeListener(event, handler));
  };
  const clearTimers = () => {
    for (const timer of timers.splice(0)) clearTimeout(timer);
    if (poll) clearInterval(poll);
    poll = undefined;
  };
  const gone = () => {
    if (groupGone || pid === undefined) return true;
    try {
      (
        input.killImpl ??
        ((p, s) => {
          process.kill(p, s);
        })
      )(-pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        groupGone = true;
        return true;
      }
      // A failed existence probe is not proof of retirement. Keep polling for ESRCH
      // until the existing deadline (Darwin can report EPERM while reaping a group).
      // Actual TERM/KILL failures remain sticky in signalGroup below.
      return false;
    }
  };
  const check = () => {
    if (checking || complete || allocating) return;
    checking = true;
    try {
      if (!exitSeen || !closeSeen || [...pipes.values()].some((value) => !value) || !gone()) return;
      complete = true;
      closed.resolve();
      clearTimers();
      input.signal.removeEventListener("abort", onAbort);
      for (const dispose of disposers.splice(0)) dispose();
      if (stopResult) {
        if (signalFault) stopResult.reject(new CodexProcessError("process_shutdown_failed"));
        else stopResult.resolve();
      }
    } finally {
      checking = false;
    }
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (groupGone || pid === undefined) return;
    try {
      (
        input.killImpl ??
        ((p, s) => {
          process.kill(p, s);
        })
      )(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") groupGone = true;
      else {
        signalFault = true;
        fail("process_shutdown_failed");
      }
    }
    check();
  };
  const noProcess = (code: CodexProcessFailure) => {
    rejectStart(code);
    exitSeen = true;
    closeSeen = true;
    groupGone = true;
    exited.resolve({ code: null, signal: null });
    check();
  };
  const stop = (): Promise<void> => {
    if (stopResult) return stopResult.promise;
    stopResult = deferred<void>();
    stopping = true;
    rejectStart("cancelled");
    // Fence synchronously and consume interruption failure without awaiting its acknowledgement.
    try {
      input.fence?.();
    } catch {
      fail("process_transport_failed");
    }
    try {
      const pending = input.interrupt?.();
      if (pending) void Promise.resolve(pending).catch(() => fail("process_transport_failed"));
    } catch {
      fail("process_transport_failed");
    }
    if (complete) {
      if (signalFault) stopResult.reject(new CodexProcessError("process_shutdown_failed"));
      else stopResult.resolve();
      return stopResult.promise;
    }
    if (!allocating && !child) {
      noProcess("cancelled");
      return stopResult.promise;
    }
    try {
      child?.stdin?.end();
    } catch {
      fail("process_transport_failed");
    }
    child?.stdout?.resume();
    child?.stderr?.resume();
    if (complete) return stopResult.promise;
    timers.push(
      setTimeout(() => signalGroup("SIGTERM"), 250),
      setTimeout(() => signalGroup("SIGKILL"), 1250),
      setTimeout(() => {
        check();
        if (complete) return;
        clearTimers();
        fail("process_shutdown_failed");
        stopResult?.reject(new CodexProcessError("process_shutdown_failed"));
        // Close/error listeners remain attached while ownership is unconfirmed. No cleanup or
        // replacement is authorized by this failure; closed can still resolve after later proof.
      }, 2000),
    );
    poll = setInterval(check, 25);
    check();
    return stopResult.promise;
  };
  const record: CodexProcess = Object.freeze({
    get pid() {
      return pid;
    },
    get stdin() {
      return child?.stdin ?? undefined;
    },
    get stdout() {
      return child?.stdout ?? undefined;
    },
    get stderr() {
      return child?.stderr ?? undefined;
    },
    started: started.promise,
    exited: exited.promise,
    closed: closed.promise,
    failure: failure.promise,
    stop,
  });
  const onAbort = () => {
    void stop().catch(() => {});
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) {
    noProcess("cancelled");
    return record;
  }
  try {
    const registered = input.register(record);
    if (registered !== undefined) {
      void Promise.resolve(registered).catch(() => {});
      noProcess("process_startup_failed");
      return record;
    }
  } catch {
    noProcess("process_startup_failed");
    return record;
  }
  if (stopping || input.signal.aborted) {
    if (!complete) noProcess("cancelled");
    return record;
  }
  allocating = true;
  try {
    child = (input.spawnImpl ?? spawn)(input.command, [...input.args], {
      cwd: input.cwd,
      env: { ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      shell: false,
    });
    // Install listeners even for ENOENT/no PID before any readiness wait or abort handling.
    listen(child, "error", () => {
      rejectStart(spawned ? "process_transport_failed" : "process_startup_failed");
      void stop().catch(() => {});
    });
    listen(child, "spawn", () => {
      spawned = true;
      if (pid === undefined) {
        rejectStart("process_startup_failed");
        void stop().catch(() => {});
      } else if (stopping || input.signal.aborted) {
        rejectStart("cancelled");
        void stop().catch(() => {});
      } else started.resolve();
    });
    listen(child, "exit", (...args) => {
      const [code, signal] = args as [number | null, NodeJS.Signals | null];
      exitSeen = true;
      exited.resolve({ code, signal });
      if (!spawned) rejectStart("process_startup_failed");
      check();
      // Parent death cannot wait indefinitely for descendant-held pipes before containment.
      if (!complete && !stopping) void stop().catch(() => {});
    });
    listen(child, "close", (...args) => {
      const [code, signal] = args as [number | null, NodeJS.Signals | null];
      closeSeen = true;
      if (!exitSeen) {
        exitSeen = true;
        exited.resolve({ code, signal });
        if (!spawned) rejectStart("process_startup_failed");
      }
      check();
      if (!complete && !stopping) void stop().catch(() => {});
    });
    for (const pipe of [child.stdin, child.stdout, child.stderr])
      if (pipe) {
        pipes.set(pipe, pipe.closed);
        listen(pipe, "close", () => {
          pipes.set(pipe, true);
          check();
        });
        listen(pipe, "error", () => {
          fail("process_transport_failed");
          rejectStart("process_transport_failed");
          void stop().catch(() => {});
        });
      }
    if (child.stderr)
      listen(child.stderr, "data", (...args) => {
        const chunk = args[0] as Buffer | string;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        tail =
          bytes.length >= 65536
            ? Buffer.from(bytes.subarray(bytes.length - 65536))
            : Buffer.concat([
                tail.subarray(Math.max(0, tail.length + bytes.length - 65536)),
                bytes,
              ]);
        // Private bounded diagnostics, never exposed through errors/events or model prompts.
      });
    if (
      Number.isInteger(child.pid) &&
      child.pid !== undefined &&
      child.pid > 0 &&
      child.pid !== process.pid
    )
      pid = child.pid;
    allocating = false;
    if (input.signal.aborted && !stopping) void stop().catch(() => {});
    if (stopping) {
      try {
        child.stdin?.end();
      } catch {
        fail("process_transport_failed");
      }
      child.stdout?.resume();
      child.stderr?.resume();
    }
    check();
    return record;
  } catch {
    allocating = false;
    noProcess("process_startup_failed");
    return record;
  }
}
