import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { constants } from "node:os";
import { isAbsolute, normalize } from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { z } from "zod";
import {
  type CodexProcess,
  CodexProcessError,
  type CodexProcessFailure,
  type SpawnCodexInput,
} from "./process.ts";

const notification = z.discriminatedUnion("event", [
  z.object({ v: z.literal(1), event: z.literal("started"), pid: z.number().int().min(2) }).strict(),
  z.object({ v: z.literal(1), event: z.literal("refused") }).strict(),
  z.object({ v: z.literal(1), event: z.literal("uncertain") }).strict(),
  z
    .object({
      v: z.literal(1),
      event: z.literal("retired"),
      code: z.number().int().min(-1).max(255),
      signal: z.number().int().min(0).max(31),
    })
    .strict(),
]);
// Resolve the host's actual signal numbers, including Darwin-specific entries.
const signals = Object.fromEntries(
  Object.entries(constants.signals).map(([name, number]) => [number, name]),
) as Readonly<Record<number, NodeJS.Signals>>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Internal transport. The caller supplies the authenticated helper from the installed release,
 * and the already-verified sandbox command. Neither executable path is model-controlled.
 * Only the helper knows the task's reserved process group; this wrapper never signals a PID.
 * Helper exit alone is insufficient evidence: require its retirement record and pipe drainage.
 */
export function spawnSupervisedCodex(input: SpawnCodexInput, supervisor: string): CodexProcess {
  const started = deferred<void>(),
    closed = deferred<void>(),
    exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>(),
    failure = deferred<CodexProcessError>();
  let child: ChildProcess | undefined, control: Duplex | undefined, pid: number | undefined;
  let allocating = false,
    stopping = false,
    complete = false,
    fault = false,
    ready = false,
    retired = false,
    refused = false,
    helperClosed = false;
  let outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let stopResult: ReturnType<typeof deferred<void>> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let pending = Buffer.alloc(0);
  const pipes = new Map<Readable | Writable, boolean>();
  const disposers: Array<() => void> = [];
  const listen = (target: EventEmitter, event: string, fn: (...args: unknown[]) => void) => {
    target.on(event, fn);
    disposers.push(() => target.removeListener(event, fn));
  };
  const fail = (code: CodexProcessFailure) => {
    fault = true;
    const error = new CodexProcessError(code);
    failure.resolve(error);
    started.reject(error);
  };
  const finish = () => {
    complete = true;
    if (deadline) clearTimeout(deadline);
    input.signal.removeEventListener("abort", abort);
    for (const dispose of disposers.splice(0)) dispose();
    closed.resolve();
    stopResult?.resolve();
  };
  const check = () => {
    if (allocating || complete || !helperClosed || [...pipes.values()].some((x) => !x)) return;
    if (
      fault ||
      !outcome ||
      outcome.signal ||
      pending.length ||
      !((refused && !ready && outcome.code === 2) || (retired && ready && outcome.code === 0))
    ) {
      fail("process_shutdown_failed");
      stopResult?.reject(new CodexProcessError("process_shutdown_failed"));
      return;
    }
    if (refused) exited.resolve({ code: null, signal: null });
    finish();
  };
  const noProcess = (code: CodexProcessFailure) => {
    const error = new CodexProcessError(code);
    started.reject(error);
    if (code !== "cancelled") failure.resolve(error);
    exited.resolve({ code: null, signal: null });
    finish();
  };
  const contain = () => {
    // Half-close only the control writer, preserving the independent lifecycle reader.
    try {
      control?.end();
      child?.stdin?.end();
    } catch {
      fail("process_transport_failed");
    }
    child?.stdout?.resume();
    child?.stderr?.resume();
  };
  const stop = () => {
    if (stopResult) return stopResult.promise;
    stopResult = deferred<void>();
    stopping = true;
    started.reject(new CodexProcessError("cancelled"));
    try {
      input.fence?.();
    } catch {
      fail("process_transport_failed");
    }
    try {
      void Promise.resolve(input.interrupt?.()).catch(() => fail("process_transport_failed"));
    } catch {
      fail("process_transport_failed");
    }
    if (complete) {
      stopResult.resolve();
      return stopResult.promise;
    }
    if (!allocating && !child) {
      noProcess("cancelled");
      return stopResult.promise;
    }
    contain();
    deadline = setTimeout(() => {
      if (!complete) {
        fail("process_shutdown_failed");
        stopResult?.reject(new CodexProcessError("process_shutdown_failed"));
        // Retain listeners and resources. A timeout never substitutes for retirement evidence.
      }
    }, 2000);
    check();
    return stopResult.promise;
  };
  const abort = () => {
    void stop().catch(() => {});
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
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) {
    noProcess("cancelled");
    return record;
  }
  try {
    const value = input.register(record);
    if (value !== undefined) {
      void Promise.resolve(value).catch(() => {});
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
  let frame: Buffer;
  try {
    if (
      !isAbsolute(supervisor) ||
      normalize(supervisor) !== supervisor ||
      supervisor.includes("\0")
    )
      throw new Error();
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        command: input.command,
        args: [...input.args],
        dir: input.cwd,
        env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
        ...(input.supervision
          ? { resources: { home: input.supervision.home, record: input.supervision.record } }
          : {}),
      }),
    );
    if (!body.length || body.length > 256 * 1024) throw new Error();
    frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length);
    body.copy(frame, 4);
  } catch {
    noProcess("process_startup_failed");
    return record;
  }
  allocating = true;
  try {
    child = (input.spawnImpl ?? spawn)(supervisor, ["native-run"], {
      cwd: input.cwd,
      env: {},
      stdio: [
        "pipe",
        "pipe",
        "pipe",
        "pipe",
        "pipe",
        ...(input.supervision ? [input.supervision.descriptor] : []),
      ],
      detached: true,
      shell: false,
    });
    control = child.stdio[3] as Duplex;
    const events = child.stdio[4] as Readable;
    for (const pipe of [child.stdin, child.stdout, child.stderr, control, events]) {
      if (!pipe) throw new Error();
      pipes.set(pipe, pipe.closed);
      listen(pipe, "close", () => {
        pipes.set(pipe, true);
        check();
      });
      listen(pipe, "error", () => {
        fail("process_transport_failed");
        abort();
      });
    }
    listen(child, "error", () => {
      if (child?.pid === undefined && !ready) {
        noProcess("process_startup_failed");
      } else {
        fail("process_transport_failed");
        abort();
      }
    });
    listen(child, "exit", (...args) => {
      outcome = { code: args[0] as number | null, signal: args[1] as NodeJS.Signals | null };
      // Status may still be buffered on its separate pipe. Evaluate only once all pipes close.
      if (!ready) started.reject(new CodexProcessError("process_startup_failed"));
      contain();
    });
    listen(child, "close", (...args) => {
      outcome = { code: args[0] as number | null, signal: args[1] as NodeJS.Signals | null };
      helperClosed = true;
      check();
    });
    listen(events, "data", (...args) => {
      try {
        const chunk = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(String(args[0]));
        if (pending.length + chunk.length > 2048) throw new Error();
        pending = Buffer.concat([pending, chunk]);
        for (let end = pending.indexOf(10); end !== -1; end = pending.indexOf(10)) {
          const row = notification.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, end))),
          );
          pending = pending.subarray(end + 1);
          if (retired || refused) throw new Error();
          if (row.event === "started") {
            if (ready || row.pid === child?.pid || row.pid === process.pid) throw new Error();
            ready = true;
            pid = row.pid;
            if (!stopping) started.resolve();
          } else if (row.event === "retired") {
            if (
              !ready ||
              fault ||
              (row.signal === 0 ? row.code < 0 : row.code !== -1 || !signals[row.signal])
            )
              throw new Error();
            retired = true;
            exited.resolve({
              code: row.signal ? null : row.code,
              signal: row.signal ? (signals[row.signal] ?? null) : null,
            });
            contain();
          } else if (row.event === "refused") {
            if (ready) throw new Error();
            refused = true;
            started.reject(
              new CodexProcessError(stopping ? "cancelled" : "process_startup_failed"),
            );
            if (!stopping) failure.resolve(new CodexProcessError("process_startup_failed"));
            contain();
          } else {
            if (!ready) throw new Error();
            fail("process_shutdown_failed");
            abort();
          }
        }
      } catch {
        fail("process_transport_failed");
        abort();
      }
    });
    // Discard diagnostics; raw task text must never become an error message or event payload.
    child.stderr?.resume();
    control.write(frame);
    allocating = false;
    if (stopping) contain();
    else if (input.signal.aborted) abort();
    check();
  } catch {
    allocating = false;
    if (!child) noProcess("process_startup_failed");
    else {
      fail("process_startup_failed");
      abort();
    }
  }
  return record;
}
