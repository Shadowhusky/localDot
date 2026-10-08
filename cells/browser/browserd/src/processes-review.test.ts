import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROCESS_TERM_MS,
  BrowserProcesses,
  type BrowserProcessHandle,
  nodeBrowserProcessDriver,
} from "./processes.ts";
import { type BrowserProcessName, browserRuntimeConfig } from "./runtime-config.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const config = browserRuntimeConfig({
  LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
  LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
  LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
  LOCALDOT_STREAM_TOKEN: "b".repeat(43),
  LOCALDOT_GATE_ADDR: "172.20.0.2",
  LOCALDOT_SCALE: "2",
});
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: Error) => e.message,
  );

function nodeFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 43210,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stdio: [null, null, null, new PassThrough(), new PassThrough()],
  });
  let alive = true;
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(pid).toBe(-43210);
    if (!alive) throw Object.assign(new Error("fixture missing group"), { code: "ESRCH" });
    if (signal !== 0) {
      alive = false;
      child.emit("exit", 0);
      child.emit("close", 0);
    }
    return true;
  });
  const fence = vi.fn(),
    drain = vi.fn(async () => {});
  const runtime = new BrowserProcesses(config, { fence, drain, driver: nodeBrowserProcessDriver });
  return { child, runtime, kill, fence, drain };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("independent runtime process boundary", () => {
  it("P1 ordinary spawn remains open until explicit Stop fully fences and drains", async () => {
    const f = nodeFixture();
    const start = f.runtime.start("chromium");
    f.child.emit("spawn");
    try {
      const channels = await start;
      expect(channels.input).toBe(f.child.stdio[3]);
      expect(channels.output).toBe(f.child.stdio[4]);
      expect(f.runtime.closed).toBe(false);
      const stop = f.runtime.stop();
      expect(f.runtime.closed).toBe(true);
      expect(f.runtime.stop()).toBe(stop);
      await stop;
      expect(f.fence).toHaveBeenCalledTimes(1);
      expect(f.drain).toHaveBeenCalledTimes(1);
      expect(f.kill).toHaveBeenCalledWith(-43210, "SIGTERM");
    } finally {
      await f.runtime.stop();
    }
  });

  it("P2 stream error fences the runtime before any later start can spawn", async () => {
    const f = nodeFixture();
    const start = f.runtime.start("xhelper");
    f.child.emit("spawn");
    const channels = await start;
    try {
      channels.output?.emit("error", new Error("private-canary"));
      expect(f.runtime.closed).toBe(true);
      const count = vi.mocked(spawn).mock.calls.length;
      await expect(f.runtime.start("display")).rejects.toThrow("closed");
      expect(spawn).toHaveBeenCalledTimes(count);
      expect(f.fence).toHaveBeenCalledTimes(1);
    } finally {
      await f.runtime.stop();
    }
  });

  it.each([
    ["chromium", "output", "end"],
    ["chromium", "input", "close"],
    ["xhelper", "output", "end"],
    ["xhelper", "input", "close"],
  ] as const)(
    "unexpected %s %s %s fences while the direct child still lives",
    async (name, side, event) => {
      const f = nodeFixture();
      const start = f.runtime.start(name as BrowserProcessName);
      f.child.emit("spawn");
      const channels = await start;
      try {
        const stream = channels[side];
        expect(stream).toBeDefined();
        stream?.emit(event);
        expect(f.runtime.closed).toBe(true);
        expect(f.fence).toHaveBeenCalledTimes(1);
        const count = vi.mocked(spawn).mock.calls.length;
        await expect(f.runtime.start("display")).rejects.toThrow("closed");
        expect(spawn).toHaveBeenCalledTimes(count);
      } finally {
        await f.runtime.stop();
      }
    },
  );

  it("P3 one failed signal does not skip sibling retirement or independent drain", async () => {
    const signals: string[][] = [],
      handles: BrowserProcessHandle[] = [];
    const drain = vi.fn(async () => {});
    const runtime = new BrowserProcesses(config, {
      fence: () => {},
      drain,
      driver: () => {
        const index = handles.length,
          sent: string[] = [];
        let alive = true;
        signals.push(sent);
        const handle: BrowserProcessHandle = {
          started: Promise.resolve(),
          channels: {},
          get closed() {
            return !alive;
          },
          exists: () => alive,
          signal: (signal) => {
            sent.push(signal);
            alive = false;
            if (index === 0) throw new Error("private-canary");
          },
        };
        handles.push(handle);
        return handle;
      },
    });
    await runtime.start("display");
    await runtime.start("stream");
    const stop = runtime.stop();
    await expect(stop).rejects.toThrow(/^Browser runtime unavailable: shutdown$/u);
    expect(signals).toEqual([["SIGTERM"], ["SIGTERM"]]);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(runtime.stop()).toBe(stop);
    await expect(runtime.start("chromium")).rejects.toThrow("closed");
  });

  it("P4 an early drain rejection cannot cancel delayed group escalation", async () => {
    vi.useFakeTimers();
    const signals: string[] = [];
    let alive = true;
    const runtime = new BrowserProcesses(config, {
      fence: () => {},
      drain: async () => {
        throw new Error("private-drain-canary");
      },
      driver: () => ({
        started: Promise.resolve(),
        channels: {},
        get closed() {
          return !alive;
        },
        exists: () => alive,
        signal: (signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") alive = false;
        },
      }),
    });
    await runtime.start("chromium");
    const stop = runtime.stop();
    const result = outcome(stop);
    await expect(result).resolves.toBe("Browser runtime unavailable: shutdown");
    await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_TERM_MS + 40);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(alive).toBe(false);
    expect(runtime.stop()).toBe(stop);
    await expect(runtime.stop()).rejects.toThrow("shutdown");
  });
});
