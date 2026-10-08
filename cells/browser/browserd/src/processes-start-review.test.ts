import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserProcesses, nodeBrowserProcessDriver } from "./processes.ts";
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

describe("startup pipe lifetime", () => {
  it("does not publish channels whose output ended before startup completion", async () => {
    const f = nodeFixture();
    const pending = outcome(f.runtime.start("chromium"));
    try {
      f.child.stdio[4]?.emit("end");
      f.child.emit("spawn");
      await expect(pending).resolves.toBe("Browser runtime unavailable: start");
      expect(f.runtime.closed).toBe(true);
      expect(f.fence).toHaveBeenCalledTimes(1);
    } finally {
      await f.runtime.stop();
      await pending;
    }
  });
});
