import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserReadiness } from "./readiness.ts";
import { browserProcessSpecs, browserRuntimeConfig } from "./runtime-config.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

function fixture(scale: 1 | 2 = 2) {
  const config = browserRuntimeConfig({
    LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
    LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
    LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
    LOCALDOT_STREAM_TOKEN: "b".repeat(43),
    LOCALDOT_GATE_ADDR: "172.20.0.2",
    LOCALDOT_SCALE: String(scale),
  });
  const controller = new AbortController();
  const header = `Screen 0: minimum 1 x 1, current ${1280 * scale} x ${800 * scale}, maximum 32767 x 32767\n`;
  const old = `${header}screen connected 1280x1024+0+0 (normal)\nscreen_1 disconnected\n`;
  const wanted = `${header}screen connected ${1280 * scale}x${800 * scale}+0+0 (normal)\nscreen_1 disconnected\n`;
  const calls: string[][] = [];
  let query = old;
  let apply = true;
  let failOnce = "";
  let abortAfter = "";
  vi.mocked(execFile).mockImplementation((...raw: unknown[]) => {
    const [executable, args, options, callback] = raw as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
      (error: Error | null, stdout: string, stderr: string) => void,
    ];
    expect(executable).toBe("/usr/bin/xrandr");
    expect(options.timeout).toBe(500);
    expect(options.maxBuffer).toBe(32768);
    expect(options.env).toEqual(browserProcessSpecs(config).display.env);
    calls.push(args);
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    queueMicrotask(() => {
      const failed = args[0] === failOnce;
      if (failed) failOnce = "";
      if (!failed && apply && args[0] === "--output") query = wanted;
      if (args[0] === abortAfter) controller.abort();
      callback(
        failed ? new Error("fixture utility failure") : null,
        args[0] === "--current" ? query : "",
        "",
      );
      child.emit("close", failed ? 1 : 0);
    });
    return child as unknown as ReturnType<typeof execFile>;
  });
  return {
    config,
    controller,
    calls,
    probe: browserReadiness(config),
    wanted,
    query: (value: string) => {
      query = value;
    },
    keepOld: () => {
      apply = false;
    },
    fail: (value: string) => {
      failOnce = value;
    },
    abort: (value: string) => {
      abortAfter = value;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("fixed browser monitor", () => {
  it.each([1, 2] as const)(
    "requires the physical output to match the scale-%s framebuffer",
    async (scale) => {
      const f = fixture(scale);
      expect(await f.probe("monitor", f.controller.signal)).toBe(true);
      expect(f.calls.map((args) => args[0])).toEqual([
        "--current",
        "--newmode",
        "--addmode",
        "--output",
        "--current",
      ]);
      expect(f.calls[3]).toEqual([
        "--output",
        "screen",
        "--mode",
        `localdot-${1280 * scale}x${800 * scale}`,
        "--pos",
        "0x0",
      ]);
      expect(browserProcessSpecs(f.config).display.args).toContain("-noreset");
      expect(browserProcessSpecs(f.config).display.args.slice(-2)).toEqual(["+extension", "RANDR"]);
    },
  );

  it("does not accept a successful utility exit while the monitor remains clipped", async () => {
    const f = fixture();
    f.keepOld();
    expect(await f.probe("monitor", f.controller.signal)).toBe(false);
  });

  it("leaves an already correct monitor unchanged", async () => {
    const f = fixture();
    f.query(f.wanted);
    expect(await f.probe("monitor", f.controller.signal)).toBe(true);
    expect(f.calls).toEqual([["--current"]]);
  });

  it.each(["screen_1 connected 100x100+0+0", "screen_2 connected"])(
    "refuses an extra connected output: %s",
    async (extra) => {
      const f = fixture();
      f.query(`${f.wanted}${extra}\n`);
      expect(await f.probe("monitor", f.controller.signal)).toBe(false);
      expect(f.calls).toEqual([["--current"]]);
    },
  );

  it("retries a partially configured monitor without recreating the mode", async () => {
    const f = fixture();
    f.fail("--addmode");
    expect(await f.probe("monitor", f.controller.signal)).toBe(false);
    expect(await f.probe("monitor", f.controller.signal)).toBe(true);
    expect(f.calls.filter((args) => args[0] === "--newmode")).toHaveLength(1);
    expect(f.calls.filter((args) => args[0] === "--addmode")).toHaveLength(2);
  });

  it("never publishes readiness or launches another utility after cancellation", async () => {
    const f = fixture();
    f.abort("--newmode");
    expect(await f.probe("monitor", f.controller.signal)).toBe(false);
    expect(f.calls.map((args) => args[0])).toEqual(["--current", "--newmode"]);
  });
});
