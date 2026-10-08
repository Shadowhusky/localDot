import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PROCESS_TERM_MS, BrowserProcesses } from "./processes.ts";
import { browserRuntimeConfig } from "./runtime-config.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const config = browserRuntimeConfig({
  LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
  LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
  LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
  LOCALDOT_STREAM_TOKEN: "b".repeat(43),
  LOCALDOT_GATE_ADDR: "172.20.0.2",
  LOCALDOT_SCALE: "2",
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scoped terminal channel and independent drain", () => {
  it.each([
    ["chromium", "output", "end", false],
    ["xhelper", "input", "finish", true],
  ] as const)(
    "%s %s %s fences once, reaps an ignoring child, and retains drain rejection=%s",
    async (name, side, terminalEvent, rejectDrain) => {
      vi.useFakeTimers();
      const child = Object.assign(new EventEmitter(), {
        pid: 43210,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stdio: [null, null, null, new PassThrough(), new PassThrough()],
      });
      vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
      let alive = true;
      const sent: string[] = [];
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect(pid).toBe(-43210);
        if (!alive) throw Object.assign(new Error("fixture gone"), { code: "ESRCH" });
        if (signal !== 0) sent.push(String(signal));
        if (signal === "SIGKILL") {
          alive = false;
          child.emit("exit", 0);
          child.emit("close", 0);
        }
        return true;
      });
      const barrier = Promise.withResolvers<void>();
      const fence = vi.fn(() => expect(alive).toBe(true));
      const drain = vi.fn(() => barrier.promise);
      const runtime = new BrowserProcesses(config, { fence, drain });
      const start = runtime.start(name);
      child.emit("spawn");
      const channels = await start;
      let stopped: Promise<void> | undefined;
      try {
        channels[side]?.emit(terminalEvent);
        expect(runtime.closed).toBe(true);
        expect(fence).toHaveBeenCalledTimes(1);
        expect(drain).toHaveBeenCalledTimes(1);
        stopped = runtime.stop();
        let settled = false;
        const result = stopped.then(
          () => {
            settled = true;
            return "resolved";
          },
          (error: Error) => {
            settled = true;
            return error.message;
          },
        );
        channels.input?.emit("finish");
        channels.input?.emit("close");
        channels.output?.emit("end");
        channels.output?.emit("close");
        channels.output?.emit("error", new Error("private-channel-canary"));
        expect(runtime.stop()).toBe(stopped);
        expect(fence).toHaveBeenCalledTimes(1);
        expect(drain).toHaveBeenCalledTimes(1);
        const calls = vi.mocked(spawn).mock.calls.length;
        await expect(runtime.start("stream")).rejects.toThrow("closed");
        expect(spawn).toHaveBeenCalledTimes(calls);
        await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_TERM_MS + 40);
        expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
        expect(alive).toBe(false);
        expect(settled).toBe(false);
        if (rejectDrain) barrier.reject(new Error("private-drain-canary"));
        else barrier.resolve();
        await expect(result).resolves.toBe(
          rejectDrain ? "Browser runtime unavailable: shutdown" : "resolved",
        );
        expect(runtime.stop()).toBe(stopped);
        expect(fence).toHaveBeenCalledTimes(1);
        expect(drain).toHaveBeenCalledTimes(1);
      } finally {
        barrier.resolve();
        stopped ??= runtime.stop();
        await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_TERM_MS + 40);
        await stopped.catch(() => {});
      }
    },
  );
});
