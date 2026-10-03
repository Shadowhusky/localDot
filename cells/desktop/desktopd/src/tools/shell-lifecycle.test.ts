import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runShell, ShellTerminationError } from "./shell.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function fixture() {
  return Object.assign(new EventEmitter(), {
    pid: 424242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

let child: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.useFakeTimers();
  child = fixture();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  // This suite never sends a signal to a real PID.
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => {
  child.stdout.destroy();
  child.stderr.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

function start(onChunk = vi.fn(), signal?: AbortSignal) {
  return runShell(
    { command: "fixture", cwd: "/fixture", env: {}, timeoutMs: 1000, maxOutputBytes: 4, signal },
    onChunk,
  );
}

describe("runShell lifecycle", () => {
  it("drains from exit at 100 through 349 ms, finishes at 350 without killing children", async () => {
    let complete = false;
    const result = start().then((done) => {
      complete = true;
      return done;
    });
    await vi.advanceTimersByTimeAsync(100);
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(249);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
    expect(process.kill).not.toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    child.stderr.emit("error", new Error("late pipe error"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("finishes immediately when pipes close naturally before the drain deadline", async () => {
    const result = start();
    child.emit("exit", 3, null);
    child.emit("close", 3, null);
    expect(await result).toMatchObject({ exitCode: 3, signal: null, timedOut: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("does not spawn when the signal is already aborted", async () => {
    const abort = new AbortController();
    const reason = new Error("stopped before admission");
    abort.abort(reason);
    await expect(start(undefined, abort.signal)).rejects.toBe(reason);
    expect(spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timers and abort listeners on spawn failure", async () => {
    const abort = new AbortController();
    const failure = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    const result = start(undefined, abort.signal);
    const assertion = expect(result).rejects.toBe(failure);
    child.emit("error", failure);
    await assertion;
    abort.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect(process.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it("kills the owned group exactly when the foreground deadline expires", async () => {
    const result = start();
    await vi.advanceTimersByTimeAsync(999);
    expect(process.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    expect(await result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  });

  it("kills on output cap during drain, drops an incomplete UTF-8 tail and stops forwarding", async () => {
    const onChunk = vi.fn();
    const result = start(onChunk);
    child.stdout.write(Buffer.from([0x61, 0xe4]));
    child.emit("exit", 0, null);
    child.stdout.write(Buffer.from([0xb8, 0xad, 0x62]));
    child.stdout.write("ignored");
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ truncated: true, exitCode: 0 });
    expect(onChunk.mock.calls.map(([chunk]) => chunk.chunk).join("")).toBe("a中");
  });

  it("flushes a partial UTF-8 tail once and allows no output after completion", async () => {
    const onChunk = vi.fn();
    const result = start(onChunk);
    child.stdout.write(Buffer.from([0xe4]));
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(250);
    await result;
    child.emit("close", 0, null);
    child.stdout.emit("data", Buffer.from("late"));
    expect(onChunk).toHaveBeenCalledExactlyOnceWith({ stream: "stdout", chunk: "�" });
  });

  it("keeps abort active during drain and removes it on completion", async () => {
    const abort = new AbortController();
    const result = start(undefined, abort.signal);
    child.emit("exit", 0, null);
    abort.abort();
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
    child.emit("close", 0, null);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects even an undefined thrown by the consumer and kills the group", async () => {
    const onChunk = vi.fn(() => {
      throw undefined;
    });
    const result = start(onChunk);
    const assertion = expect(result).rejects.toBeUndefined();
    child.stdout.write("data");
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await assertion;
  });

  it("reports pipe errors and terminates the owned group", async () => {
    const failure = new Error("fixture pipe failure");
    const result = start();
    const assertion = expect(result).rejects.toBe(failure);
    child.stderr.emit("error", failure);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await assertion;
  });

  it("accepts a macOS kill race only after the exited group is confirmed absent", async () => {
    const failure = Object.assign(new Error("already exited"), { code: "EPERM" });
    vi.mocked(process.kill)
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("reaped"), { code: "ESRCH" });
      });
    const result = start();
    child.stdout.write("over cap");
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    expect(await result).toMatchObject({ truncated: true, exitCode: 0 });
    expect(process.kill).toHaveBeenNthCalledWith(2, -child.pid, 0);
  });

  it.each(["forward", "flush"] as const)(
    "finishes once when child.kill emits an error synchronously during %s",
    async (phase) => {
      const failure = Object.assign(new Error("not permitted"), { code: "EPERM" });
      vi.mocked(process.kill).mockImplementation(() => {
        throw failure;
      });
      child.kill.mockImplementation(() => {
        child.emit("error", failure);
        return false;
      });
      const onChunk = vi.fn(() => {
        expect(child.stdout.destroyed).toBe(false);
        expect(child.stderr.destroyed).toBe(false);
      });
      const result = start(onChunk);
      const assertion = expect(result).rejects.toMatchObject({
        name: "ShellTerminationError",
        groupPid: child.pid,
        cause: failure,
      });
      if (phase === "forward") {
        // Invalid input expands beyond the cap; kill failure must prevent a late callback.
        child.stdout.write(Buffer.from([0xff, 0xff]));
      } else {
        // Decoder flush enters finish, then the child error reenters it during group kill.
        child.stdout.write(Buffer.from([0x61, 0x62, 0x63, 0xe4]));
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      }
      await assertion;
      expect(onChunk).toHaveBeenCalledTimes(phase === "forward" ? 0 : 1);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(vi.mocked(process.kill).mock.calls).toEqual([
        [-child.pid, "SIGKILL"],
        [-child.pid, 0],
      ]);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      child.stdout.emit("data", Buffer.from("late"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(onChunk).toHaveBeenCalledTimes(phase === "forward" ? 0 : 1);
      expect(process.kill).toHaveBeenCalledTimes(2);
    },
  );

  it("refuses to report success when a group remains inaccessible", async () => {
    const failure = Object.assign(new Error("not permitted"), { code: "EPERM" });
    vi.mocked(process.kill).mockImplementation(() => {
      throw failure;
    });
    const result = start();
    const assertion = expect(result).rejects.toMatchObject({
      name: "ShellTerminationError",
      groupPid: child.pid,
      cause: failure,
    });
    child.stdout.write("over cap");
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(result).rejects.toBeInstanceOf(ShellTerminationError);
  });
});
