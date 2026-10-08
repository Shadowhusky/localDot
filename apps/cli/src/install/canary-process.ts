import { spawn } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import {
  CanaryClosed,
  CanaryReady,
  CanaryRunId,
} from "../../../../packages/protocol/src/canary-process.ts";
import { ULID_PATTERN } from "../../../../packages/protocol/src/ids.ts";

const failure = () => new Error("The diagnostic gateway did not retire reliably.");

export type {
  CanaryClosed,
  CanaryReady,
} from "../../../../packages/protocol/src/canary-process.ts";
export interface CanaryProcessInput {
  verifiedKeydPath: string;
  directory: string;
  cellId: string;
  runId: string;
  directoryDescriptor: number;
}

/** Caller holds the install mutex, has verified the signed helper, and has durably recorded the
 * private directory/operation before invoking this. The caller retains the directory lease
 * descriptor until this function settles; fd3 shares that lease with the child until exit.
 * Work must retain and drain its own Docker
 * effects on cancellation. Ready contains only a generated fake key, but is still private data.
 * This transport proves child retirement, not scanner coverage or successful secret isolation. */
export async function withCanaryProcess<T>(
  input: CanaryProcessInput,
  signal: AbortSignal,
  work: (ready: CanaryReady, signal: AbortSignal, pid: number) => Promise<T>,
): Promise<{ value: T; receipt: CanaryClosed; stderr: Buffer }> {
  const expected = { ...input };
  if (
    signal.aborted ||
    !Number.isSafeInteger(expected.directoryDescriptor) ||
    expected.directoryDescriptor < 3 ||
    !CanaryRunId.safeParse(expected.runId).success ||
    !ULID_PATTERN.test(expected.cellId) ||
    [expected.verifiedKeydPath, expected.directory].some(
      (p) => !isAbsolute(p) || normalize(p) !== p || p === "/",
    )
  )
    throw failure();
  const create = () =>
    spawn(
      expected.verifiedKeydPath,
      [
        "canary-run",
        "--directory",
        expected.directory,
        "--cell",
        expected.cellId,
        "--run",
        expected.runId,
      ],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe", expected.directoryDescriptor],
      },
    );
  let child: ReturnType<typeof create>;
  try {
    child = create();
  } catch {
    throw failure();
  }
  let failed = false,
    stopping = false,
    closed = false,
    readySeen = false;
  let pending = Buffer.alloc(0),
    outputBytes = 0,
    errorBytes = 0;
  const errors: Buffer[] = [],
    task = new AbortController();
  let receipt: CanaryClosed | undefined,
    exitCode: number | null = null,
    exitSignal: string | null = null;
  let resolveReady!: (r: CanaryReady) => void,
    rejectReady!: (e: Error) => void,
    resolveClose!: () => void;
  const ready = new Promise<CanaryReady>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const closure = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const retire = () => {
    if (closed || stopping) return;
    stopping = true;
    // EOF is the normal stop request. Escalate only this child if it does not retire.
    killTimer = setTimeout(() => {
      if (!closed) {
        failed = true;
        task.abort();
        child.kill("SIGKILL");
      }
    }, 5_000);
    try {
      child.stdin?.end();
    } catch {
      failed = true;
      task.abort();
      rejectReady(failure());
    }
  };
  const fail = () => {
    failed = true;
    task.abort();
    rejectReady(failure());
    retire();
  };
  const readyTimer = setTimeout(fail, 10_000);
  const lifetime = setTimeout(fail, 9 * 60_000);
  const matches = (value: { runId: string; cellId: string }) =>
    value.runId === expected.runId && value.cellId === expected.cellId;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (failed) return;
    outputBytes += chunk.length;
    if (outputBytes > 32 * 1024) {
      fail();
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (!readySeen) {
          const value = CanaryReady.parse(parsed);
          if (stopping || !matches(value)) throw failure();
          readySeen = true;
          clearTimeout(readyTimer);
          resolveReady(Object.freeze(value));
        } else {
          if (!stopping || receipt) throw failure();
          const value = CanaryClosed.parse(parsed);
          if (!matches(value)) throw failure();
          receipt = value;
        }
      } catch {
        fail();
        return;
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    errorBytes += chunk.length;
    if (errorBytes > 64 * 1024) {
      fail();
      return;
    }
    errors.push(Buffer.from(chunk));
  });
  child.stdin?.once("error", fail);
  child.stdout?.once("error", fail);
  child.stderr?.once("error", fail);
  child.once("error", fail);
  child.once("close", (code, terminationSignal) => {
    closed = true;
    exitCode = code;
    exitSignal = terminationSignal;
    if (!stopping || !readySeen || !receipt || pending.length || code !== 0 || terminationSignal)
      fail();
    clearTimeout(readyTimer);
    clearTimeout(lifetime);
    clearTimeout(killTimer);
    resolveClose();
  });
  signal.addEventListener("abort", fail, { once: true });
  if (signal.aborted || !child.stdin || !child.stdout || !child.stderr) fail();
  let value: T | undefined;
  try {
    const hello = await ready;
    if (failed || !Number.isSafeInteger(child.pid) || !child.pid || child.pid <= 0) throw failure();
    value = await work(hello, task.signal, child.pid);
  } catch {
    fail();
  } finally {
    retire();
    await closure;
    clearTimeout(readyTimer);
    clearTimeout(lifetime);
    clearTimeout(killTimer);
    signal.removeEventListener("abort", fail);
  }
  if (signal.aborted || failed || !receipt || exitCode !== 0 || exitSignal) throw failure();
  return { value: value as T, receipt, stderr: Buffer.concat(errors) };
}
