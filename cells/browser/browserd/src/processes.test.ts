import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROCESS_START_MS,
  BROWSER_PROCESS_STOP_MS,
  BROWSER_PROCESS_TERM_MS,
  BrowserProcesses,
  type BrowserProcessHandle,
  nodeBrowserProcessDriver,
} from "./processes.ts";
import {
  type BrowserProcessName,
  type BrowserProcessSpec,
  browserProcessSpecs,
  browserRuntimeConfig,
} from "./runtime-config.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const config = browserRuntimeConfig({
  LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
  LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
  LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
  LOCALDOT_STREAM_TOKEN: "b".repeat(43),
  LOCALDOT_GATE_ADDR: "172.20.0.2",
  LOCALDOT_SCALE: "2",
});

function fixture(options: { pending?: boolean; ignoreTerm?: boolean; ignoreKill?: boolean } = {}) {
  const groups: {
    spec: BrowserProcessSpec;
    handle: BrowserProcessHandle;
    startup: ReturnType<typeof Promise.withResolvers<void>>;
    failure(): void;
    finish(): void;
    leaderExit(): void;
    signals: string[];
  }[] = [];
  const fence = vi.fn();
  const drain = vi.fn(async () => {});
  const writersExited = vi.fn();
  const runtime = new BrowserProcesses(config, {
    fence,
    drain,
    writersExited,
    driver: (spec, failure) => {
      let alive = true;
      let closed = false;
      const startup = Promise.withResolvers<void>();
      const signals: string[] = [];
      const finish = () => {
        alive = false;
        closed = true;
      };
      const handle: BrowserProcessHandle = {
        started: startup.promise,
        get closed() {
          return closed;
        },
        channels: Object.freeze({}),
        signal: (signal) => {
          signals.push(signal);
          if (signal === "SIGTERM" ? !options.ignoreTerm : !options.ignoreKill) finish();
        },
        exists: () => alive,
      };
      groups.push({
        spec,
        handle,
        startup,
        failure,
        finish,
        leaderExit: () => {
          closed = true;
        },
        signals,
      });
      if (!options.pending) startup.resolve();
      return handle;
    },
  });
  return { runtime, groups, fence, drain, writersExited };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("private browser process supervision", () => {
  it("notifies physical writer exit before waiting for action-owner drain", async () => {
    const test = fixture();
    const drained = Promise.withResolvers<void>();
    test.drain.mockImplementation(() => drained.promise);
    await test.runtime.start("chromium");
    let stopped = false;
    const stop = test.runtime.stop().then(() => {
      stopped = true;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(test.writersExited).toHaveBeenCalledOnce();
    expect(test.groups[0]?.handle.exists()).toBe(false);
    expect(stopped).toBe(false);
    drained.resolve();
    await stop;
  });

  it("a closed leader with a surviving group cannot report writer exit", async () => {
    vi.useFakeTimers();
    const test = fixture({ ignoreTerm: true, ignoreKill: true });
    await test.runtime.start("chromium");
    test.groups[0]?.leaderExit();
    const stop = test.runtime.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(test.writersExited).not.toHaveBeenCalled();
    test.groups[0]?.finish();
    await vi.advanceTimersByTimeAsync(20);
    await stop;
    expect(test.writersExited).toHaveBeenCalledOnce();
  });
  it("starts each fixed process at most once without exposing process IDs", async () => {
    const test = fixture();
    const channels = await test.runtime.start("display");
    expect(Object.keys(channels)).toEqual([]);
    expect(test.groups[0]?.spec.executable).toBe("/usr/bin/Xvfb");
    await expect(test.runtime.start("display")).rejects.toThrow("start");
    await expect(test.runtime.start("toString" as BrowserProcessName)).rejects.toThrow("start");
    expect(test.groups).toHaveLength(1);
    expect(test.runtime.closed).toBe(false);
    expect(test.groups[0]?.signals).toEqual([]);
    await test.runtime.stop();
  });

  it("fences synchronously before signalling any process and makes stop idempotent", async () => {
    const test = fixture();
    await test.runtime.start("display");
    await test.runtime.start("chromium");
    test.fence.mockImplementation(() => {
      expect(test.runtime.closed).toBe(true);
      expect(test.groups.every((group) => group.signals.length === 0)).toBe(true);
    });
    const first = test.runtime.stop();
    expect(test.fence).toHaveBeenCalledTimes(1);
    expect(test.runtime.stop()).toBe(first);
    expect(test.groups.map((group) => group.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
    await first;
    await expect(test.runtime.start("stream")).rejects.toThrow("closed");
  });

  it("an unexpected process exit immediately closes all sibling admission", async () => {
    const test = fixture();
    await test.runtime.start("display");
    await test.runtime.start("stream");
    test.groups[0]?.failure();
    expect(test.fence).toHaveBeenCalledTimes(1);
    expect(test.runtime.closed).toBe(true);
    expect(test.groups[1]?.signals).toEqual(["SIGTERM"]);
    await test.runtime.stop();
  });

  it("does not claim shutdown while owned descendants survive their leader", async () => {
    vi.useFakeTimers();
    const test = fixture({ ignoreTerm: true });
    await test.runtime.start("chromium");
    test.groups[0]?.leaderExit();
    let settled = false;
    const stop = test.runtime.stop().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_TERM_MS - 1);
    expect(settled).toBe(false);
    expect(test.groups[0]?.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(41);
    await stop;
    expect(test.groups[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("refuses a successful shutdown receipt if an owned process cannot be killed", async () => {
    vi.useFakeTimers();
    const test = fixture({ ignoreTerm: true, ignoreKill: true });
    await test.runtime.start("chromium");
    const result = test.runtime.stop().catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_STOP_MS + 20);
    expect(await result).toBe("Browser runtime unavailable: shutdown");
    expect(test.groups[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(test.runtime.closed).toBe(true);
  });

  it("requires the independent native and control drain barrier after process exit", async () => {
    const test = fixture();
    const barrier = Promise.withResolvers<void>();
    test.drain.mockImplementation(() => barrier.promise);
    await test.runtime.start("xhelper");
    let settled = false;
    const stop = test.runtime.stop().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(test.groups[0]?.handle.closed).toBe(true);
    expect(settled).toBe(false);
    barrier.resolve();
    await stop;
  });

  it("bounds a drain barrier that never resolves", async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.drain.mockImplementation(() => new Promise(() => {}));
    await test.runtime.start("xhelper");
    const result = test.runtime.stop().catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_STOP_MS);
    expect(await result).toBe("Browser runtime unavailable: shutdown");
  });

  it("still terminates every group when the synchronous fence callback throws", async () => {
    const test = fixture();
    await test.runtime.start("display");
    test.fence.mockImplementation(() => {
      throw new Error("private-canary");
    });
    await expect(test.runtime.stop()).rejects.toThrow(/^Browser runtime unavailable: shutdown$/u);
    expect(test.groups[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("bounds startup and closes all admission when a child never becomes ready", async () => {
    vi.useFakeTimers();
    const test = fixture({ pending: true });
    const result = test.runtime.start("display").catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_START_MS);
    expect(await result).toBe("Browser runtime unavailable: start");
    expect(test.fence).toHaveBeenCalledTimes(1);
    await test.runtime.stop();
  });

  it("cancels pending startup immediately when stop arrives", async () => {
    const test = fixture({ pending: true });
    const result = test.runtime.start("display").catch((error: Error) => error.message);
    await test.runtime.stop();
    expect(await result).toBe("Browser runtime unavailable: start");
    test.groups[0]?.startup.resolve();
    expect(test.runtime.closed).toBe(true);
  });

  it("does not publish channels when a child dies just after reporting started", async () => {
    const test = fixture({ pending: true });
    const result = test.runtime.start("chromium");
    test.groups[0]?.startup.resolve();
    test.groups[0]?.failure();
    await expect(result).rejects.toThrow("start");
    await test.runtime.stop();
  });

  it("handles reentrant stop from the fence without issuing another teardown", async () => {
    const test = fixture();
    await test.runtime.start("display");
    let reentrant: Promise<void> | undefined;
    test.fence.mockImplementation(() => {
      reentrant = test.runtime.stop();
    });
    const stop = test.runtime.stop();
    expect(reentrant).toBe(stop);
    await stop;
    expect(test.fence).toHaveBeenCalledTimes(1);
  });

  it("contains driver setup failure without reflecting executable or private error text", async () => {
    const fence = vi.fn();
    const runtime = new BrowserProcesses(config, {
      fence,
      drain: async () => {},
      driver: () => {
        throw new Error("private-canary");
      },
    });
    await expect(runtime.start("chromium")).rejects.toThrow(
      /^Browser runtime unavailable: start$/u,
    );
    await runtime.stop();
    expect(fence).toHaveBeenCalledTimes(1);
  });

  it("keeps a synchronously failing launch in the drain barrier until its group is gone", async () => {
    vi.useFakeTimers();
    let alive = true;
    let stopped = false;
    const signal = vi.fn();
    const fence = vi.fn();
    const runtime = new BrowserProcesses(config, {
      fence,
      drain: async () => {},
      driver: (_spec, failure) => {
        failure();
        return {
          started: Promise.resolve(),
          get closed() {
            return !alive;
          },
          channels: Object.freeze({}),
          signal,
          exists: () => alive,
        };
      },
    });
    await expect(runtime.start("chromium")).rejects.toThrow("start");
    const stop = runtime.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(stopped).toBe(false);
    expect(signal).toHaveBeenCalledWith("SIGKILL");
    alive = false;
    await vi.advanceTimersByTimeAsync(20);
    await stop;
    expect(fence).toHaveBeenCalledTimes(1);
  });
});

describe("Node process-group boundary", () => {
  function childFixture() {
    const child = Object.assign(new EventEmitter(), {
      pid: 43210,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stdio: [null, null, null, new PassThrough(), new PassThrough()],
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    return { child, kill };
  }

  it.each(["chromium", "xhelper", "stream"] as const)(
    "launches %s without a shell, inherited environment, or raw output logs",
    async (name) => {
      const { child, kill } = childFixture();
      const failure = vi.fn();
      const spec = browserProcessSpecs(config)[name];
      const handle = nodeBrowserProcessDriver(spec, failure);
      child.emit("spawn");
      await handle.started;
      expect(spawn).toHaveBeenLastCalledWith(spec.executable, [...spec.args], {
        cwd: "/",
        env: { ...spec.env },
        detached: true,
        shell: false,
        stdio:
          name === "chromium"
            ? ["ignore", "ignore", "ignore", "pipe", "pipe"]
            : name === "xhelper"
              ? ["pipe", "pipe", "ignore"]
              : "ignore",
      });
      if (name === "chromium") {
        expect(handle.channels.input).toBe(child.stdio[3]);
        expect(handle.channels.output).toBe(child.stdio[4]);
      }
      expect(handle.exists()).toBe(true);
      handle.signal("SIGTERM");
      expect(kill).toHaveBeenLastCalledWith(-43210, "SIGTERM");
      child.emit("exit", 0);
      expect(failure).toHaveBeenCalledTimes(1);
      expect(handle.closed).toBe(false);
      child.emit("close", 0);
      expect(handle.closed).toBe(true);
    },
  );

  it("retires a gone group so later cleanup cannot signal a reused process ID", async () => {
    const { child, kill } = childFixture();
    const handle = nodeBrowserProcessDriver(browserProcessSpecs(config).chromium, vi.fn());
    child.emit("spawn");
    await handle.started;
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(handle.exists()).toBe(false);
    const calls = kill.mock.calls.length;
    handle.signal("SIGKILL");
    expect(handle.exists()).toBe(false);
    expect(kill).toHaveBeenCalledTimes(calls);
  });

  it.each([
    ["chromium", "output", "close", false],
    ["xhelper", "output", "close", false],
    ["chromium", "input", "finish", false],
    ["xhelper", "input", "finish", false],
    ["chromium", "input", "close", true],
    ["xhelper", "input", "close", true],
    ["chromium", "output", "close", true],
    ["xhelper", "output", "close", true],
  ] as const)(
    "%s %s %s contains its owner, including startup=%s and repeated cleanup events",
    async (name, side, event, duringStartup) => {
      const { child, kill } = childFixture();
      let alive = true;
      const fence = vi.fn(() => {
        expect(alive).toBe(true);
      });
      const drain = vi.fn(async () => {});
      kill.mockImplementation((_processId, signal) => {
        if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        if (signal !== 0) {
          alive = false;
          child.emit("exit", 0);
          child.emit("close", 0);
        }
        return true;
      });
      const runtime = new BrowserProcesses(config, { fence, drain });
      const started = runtime.start(name);
      const startupResult = started.then(
        () => "published",
        (error: Error) => error.message,
      );
      if (!duringStartup) {
        child.emit("spawn");
        await expect(startupResult).resolves.toBe("published");
        expect(runtime.closed).toBe(false);
      }
      const channel =
        name === "chromium"
          ? child.stdio[side === "input" ? 3 : 4]
          : side === "input"
            ? child.stdin
            : child.stdout;
      expect(channel).toBeDefined();
      channel?.emit(event);
      expect(runtime.closed).toBe(true);
      expect(fence).toHaveBeenCalledTimes(1);
      const stopped = runtime.stop();
      channel?.emit("close");
      child.emit("close", 0);
      expect(runtime.stop()).toBe(stopped);
      if (duringStartup) {
        child.emit("spawn");
        await expect(startupResult).resolves.toBe("Browser runtime unavailable: start");
      }
      await stopped;
      expect(drain).toHaveBeenCalledTimes(1);
      expect(fence).toHaveBeenCalledTimes(1);
      expect(kill.mock.calls.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
      await expect(runtime.start("display")).rejects.toThrow("closed");
    },
  );

  it("never treats a group inspection permission error as a successful drain", async () => {
    const { child, kill } = childFixture();
    const handle = nodeBrowserProcessDriver(browserProcessSpecs(config).chromium, vi.fn());
    child.emit("spawn");
    await handle.started;
    kill.mockImplementation(() => {
      throw Object.assign(new Error("private-canary"), { code: "EPERM" });
    });
    expect(() => handle.exists()).toThrow(/^Browser runtime unavailable: shutdown$/u);
  });

  it("fences transport stream errors and reflects only a fixed startup error", async () => {
    const { child } = childFixture();
    const failure = vi.fn();
    const handle = nodeBrowserProcessDriver(browserProcessSpecs(config).chromium, failure);
    child.stdio[4]?.emit("error", new Error("private-page-canary"));
    expect(failure).toHaveBeenCalledTimes(1);
    child.emit("error", new Error("private-spawn-canary"));
    await expect(handle.started).rejects.toThrow(/^Browser runtime unavailable: start$/u);
  });
});

describe("sign-in browser replacement", () => {
  it("reaps only Chromium and ignores late exits from its retired generation", async () => {
    const f = fixture();
    await f.runtime.start("display");
    await f.runtime.start("chromium");
    const previous = f.groups[1];
    if (!previous) throw new Error("missing fixture process");
    const manual = { ...browserProcessSpecs(config).chromium, channel: "none" as const };
    await f.runtime.replaceChromium(manual, () => {
      previous.finish();
      return true;
    });
    expect(f.groups).toHaveLength(3);
    expect(f.groups[0]?.signals).toEqual([]);
    previous.failure();
    expect(f.runtime.closed).toBe(false);
    expect(f.fence).not.toHaveBeenCalled();
    f.groups[2]?.failure();
    expect(f.runtime.closed).toBe(true);
    await f.runtime.stop();
  });
  it("never opens a second writer when the old process group cannot exit", async () => {
    vi.useFakeTimers();
    const f = fixture({ ignoreTerm: true });
    await f.runtime.start("chromium");
    const outcome = f.runtime
      .replaceChromium(browserProcessSpecs(config).chromium, () => false)
      .catch(() => "refused");
    await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_STOP_MS + 40);
    expect(await outcome).toBe("refused");
    expect(f.groups).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_STOP_MS + 40);
    await f.runtime.stop();
  });
});

it("keeps a manual browser alive when a page refuses the normal Quit command", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.runtime.start("chromium");
  const outcome = f.runtime
    .replaceChromium(browserProcessSpecs(config).chromium, () => true, true)
    .catch((error) => error.reason);
  await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_STOP_MS + 20);
  expect(await outcome).toBe("busy");
  expect(f.runtime.closed).toBe(false);
  expect(f.groups).toHaveLength(1);
  expect(f.groups[0]?.signals).toEqual([]);
  await f.runtime.stop();
});
