import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_READINESS_COMMAND_DRAIN_MS,
  BrowserReadinessRetirementError,
  browserReadiness,
} from "./readiness.ts";
import { browserRuntimeConfig } from "./runtime-config.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const config = browserRuntimeConfig({
  LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
  LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
  LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
  LOCALDOT_STREAM_TOKEN: "b".repeat(43),
  LOCALDOT_GATE_ADDR: "172.20.0.2",
  LOCALDOT_SCALE: "2",
});
const display = "dimensions: 2560x1600 pixels";

function fixture(synchronousError = false) {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  let callback = (_error: Error | null, _stdout: string) => {};
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    callback = args[3] as typeof callback;
    if (synchronousError) callback(new Error("private command detail"), "");
    return child as unknown as ReturnType<typeof execFile>;
  });
  return {
    child,
    probe: browserReadiness(config),
    respond: (error: Error | null) => callback(error, display),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("scoped readiness retirement boundaries", () => {
  it("contains a callback error before child publication and a synchronous kill-error callback", async () => {
    const test = fixture(true);
    let emitted = false;
    test.child.kill.mockImplementation(() => {
      if (!emitted) {
        emitted = true;
        test.child.emit("error", new Error("private kill event"));
      }
      return false;
    });
    const pending = test
      .probe("display", new AbortController().signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(BROWSER_READINESS_COMMAND_DRAIN_MS + 1);
    expect(await pending).toBeInstanceOf(BrowserReadinessRetirementError);
    expect(
      test.child.kill,
      "one native kill request owns the entire retirement attempt",
    ).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains timeout uncertainty after a throwing kill and ignores later success and closure", async () => {
    const test = fixture();
    test.child.kill.mockImplementation(() => {
      throw new Error("private kill detail");
    });
    const pending = test
      .probe("display", new AbortController().signal)
      .catch((error: unknown) => error);
    test.respond(null);
    await vi.advanceTimersByTimeAsync(500 + BROWSER_READINESS_COMMAND_DRAIN_MS + 1);
    const error = await pending;
    expect(error).toBeInstanceOf(BrowserReadinessRetirementError);
    expect(String(error)).not.toContain("private");
    test.respond(null);
    test.child.emit("close", 0);
    test.child.emit("error", new Error("late ignored error"));
    expect(await pending).toBe(error);
    expect(test.child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("admits successful output only after actual closure before the execution deadline", async () => {
    const test = fixture();
    const pending = test.probe("display", new AbortController().signal);
    test.respond(null);
    await vi.advanceTimersByTimeAsync(499);
    test.child.emit("close", 0);
    expect(await pending).toBe(true);
    expect(test.child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts confirmed closure just before the retirement deadline without restoring readiness", async () => {
    const test = fixture();
    const pending = test.probe("display", new AbortController().signal);
    test.respond(new Error("command refused"));
    await vi.advanceTimersByTimeAsync(BROWSER_READINESS_COMMAND_DRAIN_MS - 1);
    test.child.emit("close", 1);
    expect(await pending).toBe(false);
    test.respond(null);
    expect(await pending).toBe(false);
    expect(test.child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
