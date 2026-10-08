import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { withCanaryProcess } from "./canary-process.ts";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
afterEach(() => {
  mock.spawn.mockReset();
  vi.useRealTimers();
});
const input = {
  verifiedKeydPath: "/verified/keyd",
  directory: "/private/fixture",
  directoryDescriptor: 42,
  cellId: "01JXYZ00000000000000000001",
  runId: "01234567-89ab-4cde-8fab-0123456789ab",
};
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  mock.spawn.mockReturnValue(child);
  const ready = {
    v: 1,
    type: "ready",
    runId: input.runId,
    cellId: input.cellId,
    port: 49123,
    proxyToken: "t".repeat(43),
    caCertPem: `-----BEGIN CERTIFICATE-----\n${"A".repeat(128)}\n-----END CERTIFICATE-----\n`,
    surrogate: `ld_key_${"a".repeat(22)}_${"b".repeat(6)}`,
    syntheticSecret: `canary-${"c".repeat(64)}`,
    challenge: "d".repeat(32),
    url: `https://canary.localdot.invalid/v1/canary/${"d".repeat(32)}`,
  };
  const closed = {
    v: 1,
    type: "closed",
    runId: input.runId,
    cellId: input.cellId,
    gatewayClosed: true,
    echo: { started: 1, authenticated: 1, reflected: 1, active: 0, closed: true },
  };
  const send = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
  return {
    child,
    ready,
    closed,
    send,
    close: (code: number | null = 0, signal: string | null = null) =>
      child.emit("close", code, signal),
  };
}
it("uses the fixed verified command, private pipes and clean environment, then waits for actual child closure", async () => {
  const f = fixture(),
    work = vi.fn(async (ready, _signal, pid) => {
      expect(ready).toEqual(f.ready);
      expect(Object.isFrozen(ready)).toBe(true);
      expect(pid).toBe(123);
      return "scanned";
    });
  let settled = false;
  const result = withCanaryProcess(input, new AbortController().signal, work).finally(() => {
    settled = true;
  });
  expect(mock.spawn).toHaveBeenCalledWith(
    "/verified/keyd",
    ["canary-run", "--directory", input.directory, "--cell", input.cellId, "--run", input.runId],
    { cwd: "/", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe", 42] },
  );
  const bytes = Buffer.from(`${JSON.stringify(f.ready)}\n`);
  f.child.stdout.write(bytes.subarray(0, 19));
  f.child.stdout.write(bytes.subarray(19));
  await setImmediate();
  expect(f.child.stdin.writableEnded).toBe(true);
  f.child.stderr.write("audit diagnostic");
  f.send(f.closed);
  f.child.emit("exit", 0, null);
  await setImmediate();
  expect(settled).toBe(false);
  f.close();
  expect(await result).toEqual({
    value: "scanned",
    receipt: f.closed,
    stderr: Buffer.from("audit diagnostic"),
  });
  expect(f.child.kill).not.toHaveBeenCalled();
});
it.each(["stdin", "stdout", "stderr"])(
  "drains child closure when the %s pipe is missing",
  async (stream) => {
    const f = fixture(),
      work = vi.fn();
    Object.defineProperty(f.child, stream, { value: null });
    let settled = false;
    const result = withCanaryProcess(input, new AbortController().signal, work)
      .catch((e) => e)
      .finally(() => {
        settled = true;
      });
    await setImmediate();
    expect(settled).toBe(false);
    expect(work).not.toHaveBeenCalled();
    f.close(1);
    expect(await result).toBeInstanceOf(Error);
  },
);
it.each(["relative-helper", "relative-directory", "root-directory", "cell", "run", "cancelled"])(
  "refuses %s before spawning",
  async (fault) => {
    const value = { ...input },
      controller = new AbortController();
    if (fault === "relative-helper") value.verifiedKeydPath = "keyd";
    if (fault === "relative-directory") value.directory = "relative";
    if (fault === "root-directory") value.directory = "/";
    if (fault === "cell") value.cellId = "invalid";
    if (fault === "run") value.runId = "invalid";
    if (fault === "cancelled") controller.abort();
    await expect(withCanaryProcess(value, controller.signal, vi.fn())).rejects.toThrow();
    expect(mock.spawn).not.toHaveBeenCalled();
  },
);
it.each([-1, 0, 1, 2, 3.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "refuses an invalid directory descriptor %s before spawning",
  async (directoryDescriptor) => {
    await expect(
      withCanaryProcess({ ...input, directoryDescriptor }, new AbortController().signal, vi.fn()),
    ).rejects.toThrow();
    expect(mock.spawn).not.toHaveBeenCalled();
  },
);
it.each([
  "run",
  "cell",
  "port",
  "token",
  "surrogate",
  "secret",
  "url",
  "certificate",
  "extra",
  "utf8",
  "overflow",
  "spawn-error",
  "stdout-error",
])("refuses %s readiness and drains before returning", async (fault) => {
  const f = fixture(),
    work = vi.fn();
  let settled = false;
  const result = withCanaryProcess(input, new AbortController().signal, work)
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  if (fault === "run") f.ready.runId = "11234567-89ab-4cde-8fab-0123456789ab";
  if (fault === "cell") f.ready.cellId = "01JXYZ00000000000000000002";
  if (fault === "port") f.ready.port = 80;
  if (fault === "token") f.ready.proxyToken = "invalid";
  if (fault === "surrogate") f.ready.surrogate = "invalid";
  if (fault === "secret") f.ready.syntheticSecret = "actual-untrusted-input";
  if (fault === "url") f.ready.url = "https://other.invalid/";
  if (fault === "certificate") f.ready.caCertPem += "trailing";
  if (fault === "extra") Object.assign(f.ready, { privateDetail: "hidden" });
  if (fault === "utf8") f.child.stdout.write(Buffer.from([0xff, 10]));
  else if (fault === "overflow") f.child.stdout.write(Buffer.alloc(32769));
  else if (fault === "spawn-error") f.child.emit("error", new Error("private error"));
  else if (fault === "stdout-error") f.child.stdout.emit("error", new Error("private error"));
  else f.send(f.ready);
  await setImmediate();
  expect(settled).toBe(false);
  expect(work).not.toHaveBeenCalled();
  expect(f.child.stdin.writableEnded).toBe(true);
  f.close(1);
  expect((await result).message).toBe("The diagnostic gateway did not retire reliably.");
});
it.each([
  "no-receipt",
  "run",
  "active",
  "not-closed",
  "counts",
  "gateway",
  "duplicate",
  "trailing",
  "stderr-overflow",
  "code",
  "signal",
])("refuses %s retirement", async (fault) => {
  const f = fixture();
  const result = withCanaryProcess(input, new AbortController().signal, async () => "value").catch(
    (e) => e,
  );
  f.send(f.ready);
  await setImmediate();
  if (fault === "run") f.closed.runId = "11234567-89ab-4cde-8fab-0123456789ab";
  if (fault === "active") f.closed.echo.active = 1;
  if (fault === "not-closed") f.closed.echo.closed = false;
  if (fault === "counts") f.closed.echo.reflected = 2;
  if (fault === "gateway") f.closed.gatewayClosed = false;
  if (fault !== "no-receipt") f.send(f.closed);
  if (fault === "duplicate") f.send(f.closed);
  if (fault === "trailing") f.child.stdout.write("private fragment");
  if (fault === "stderr-overflow") f.child.stderr.write(Buffer.alloc(65537));
  f.close(fault === "code" ? 1 : 0, fault === "signal" ? "SIGTERM" : null);
  expect((await result).message).toBe("The diagnostic gateway did not retire reliably.");
});
it.each(["caller", "child"])(
  "retains callback ownership until it drains after %s cancellation",
  async (fault) => {
    const f = fixture(),
      controller = new AbortController();
    let finish!: () => void,
      taskSignal: AbortSignal | undefined,
      settled = false;
    const result = withCanaryProcess(input, controller.signal, async (_ready, signal) => {
      taskSignal = signal;
      await new Promise<void>((r) => {
        finish = r;
      });
    })
      .catch((e) => e)
      .finally(() => {
        settled = true;
      });
    f.send(f.ready);
    await setImmediate();
    if (fault === "caller") controller.abort();
    else f.close(1);
    expect(taskSignal?.aborted).toBe(true);
    if (fault === "caller") f.close(1);
    await setImmediate();
    expect(settled).toBe(false);
    finish();
    expect(await result).toBeInstanceOf(Error);
  },
);
it("terminates only its own stuck child and still waits for closure", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let settled = false;
  const result = withCanaryProcess(input, new AbortController().signal, vi.fn())
    .catch((e) => e)
    .finally(() => {
      settled = true;
    });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.child.stdin.writableEnded).toBe(true);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(settled).toBe(false);
  f.close(null, "SIGKILL");
  expect(await result).toBeInstanceOf(Error);
  expect(vi.getTimerCount()).toBe(0);
});
it("sanitizes callback errors and still requests/drains retirement", async () => {
  const f = fixture();
  const result = withCanaryProcess(input, new AbortController().signal, async () => {
    throw new Error("private scan detail");
  }).catch((e) => e);
  f.send(f.ready);
  await setImmediate();
  expect(f.child.stdin.writableEnded).toBe(true);
  f.close(1);
  expect((await result).message).not.toContain("private");
});
it("bounds the full running lifetime and waits for callback and process drainage", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let taskSignal: AbortSignal | undefined;
  const result = withCanaryProcess(input, new AbortController().signal, async (_ready, signal) => {
    taskSignal = signal;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }).catch((e) => e);
  f.send(f.ready);
  await vi.advanceTimersByTimeAsync(0);
  expect(taskSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(9 * 60_000);
  expect(taskSignal?.aborted).toBe(true);
  expect(f.child.stdin.writableEnded).toBe(true);
  f.close(1);
  expect(await result).toBeInstanceOf(Error);
  expect(vi.getTimerCount()).toBe(0);
});
it("refuses unsolicited retirement while work is running", async () => {
  const f = fixture();
  let finish!: () => void, taskSignal: AbortSignal | undefined;
  const result = withCanaryProcess(input, new AbortController().signal, async (_ready, signal) => {
    taskSignal = signal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  }).catch((e) => e);
  f.send(f.ready);
  await setImmediate();
  f.send(f.closed);
  expect(taskSignal?.aborted).toBe(true);
  f.close(0);
  finish();
  expect(await result).toBeInstanceOf(Error);
});
it("sanitizes synchronous spawn failure without invoking work", async () => {
  mock.spawn.mockImplementation(() => {
    throw new Error("private executable detail");
  });
  const work = vi.fn();
  await expect(withCanaryProcess(input, new AbortController().signal, work)).rejects.toThrow(
    /^The diagnostic gateway did not retire reliably\.$/,
  );
  expect(work).not.toHaveBeenCalled();
});
