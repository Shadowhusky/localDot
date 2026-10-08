import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PROCESS_STOP_MS } from "./processes.ts";
import { BrowserRuntime } from "./runtime.ts";
import { browserRuntimeConfig } from "./runtime-config.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));

const config = browserRuntimeConfig({
  LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
  LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
  LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
  LOCALDOT_STREAM_TOKEN: "b".repeat(43),
  LOCALDOT_GATE_ADDR: "172.20.0.2",
  LOCALDOT_SCALE: "2",
});
const runtimes: BrowserRuntime[] = [];

function fixture(closeOnAbort: boolean) {
  vi.useFakeTimers();
  let utilityAlive = false;
  let displayAlive = false;
  const launched = Promise.withResolvers<void>();
  const utility = Object.assign(new EventEmitter(), {
    pid: 73500,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    expect(args[0]).toBe("/usr/bin/xdpyinfo");
    utilityAlive = true;
    const options = args[2] as { signal: AbortSignal; killSignal: string };
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    options.signal.addEventListener("abort", () => {
      utility.kill();
      callback(Object.assign(new Error("operation aborted"), { code: "ABORT_ERR" }), "", "");
      if (closeOnAbort) {
        utilityAlive = false;
        utility.signalCode = "SIGKILL";
        utility.emit("exit", null, "SIGKILL");
        utility.emit("close", null, "SIGKILL");
      }
    });
    launched.resolve();
    return utility as unknown as ReturnType<typeof execFile>;
  });
  const runtime = new BrowserRuntime(config, {
    prepare: async () => {},
    driver: () => {
      displayAlive = true;
      return {
        started: Promise.resolve(),
        channels: {},
        get closed() {
          return !displayAlive;
        },
        signal() {
          displayAlive = false;
        },
        exists() {
          return displayAlive;
        },
      };
    },
  });
  runtimes.push(runtime);
  return { runtime, launched, utilityAlive: () => utilityAlive, displayAlive: () => displayAlive };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close().catch(() => {})));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("runtime ownership of readiness commands", () => {
  it("does not treat an execFile abort callback as physical readiness-process closure", async () => {
    const test = fixture(false);
    const startup = test.runtime.start().then(
      () => "ready",
      () => "refused",
    );
    await test.launched.promise;
    const stopped = test.runtime.stop().then(
      () => "confirmed",
      () => "uncertain",
    );
    await vi.advanceTimersByTimeAsync(BROWSER_PROCESS_STOP_MS + 1);
    expect(await startup).toBe("refused");
    expect(test.displayAlive()).toBe(false);
    expect(test.utilityAlive()).toBe(true);
    expect(await stopped, "readiness utility closure remains unconfirmed").toBe("uncertain");
  });

  it("confirms retirement when the readiness utility closes after cancellation", async () => {
    const test = fixture(true);
    const startup = test.runtime.start().then(
      () => "ready",
      () => "refused",
    );
    await test.launched.promise;
    const stopped = test.runtime.stop();
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(await startup).toBe("refused");
    expect(test.displayAlive()).toBe(false);
    expect(test.utilityAlive()).toBe(false);
  });
});
