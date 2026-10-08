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

function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  const controller = new AbortController();
  let callback: (error: Error | null, stdout: string, stderr: string) => void = () => {};
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    callback = args[3] as typeof callback;
    return child as unknown as ReturnType<typeof execFile>;
  });
  return {
    child,
    controller,
    probe: browserReadiness(config),
    respond(error: Error | null, stdout = display) {
      callback(error, stdout, "");
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("readiness utility physical closure", () => {
  it("waits for close even after a successful command callback", async () => {
    const test = fixture();
    let settled = false;
    const pending = test.probe("display", test.controller.signal).finally(() => {
      settled = true;
    });
    test.respond(null);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    test.child.emit("close", 0);
    expect(await pending).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an early error unconfirmed until the bounded close deadline", async () => {
    const test = fixture();
    const pending = test.probe("display", test.controller.signal).catch((error: unknown) => error);
    test.respond(new Error("fixture failure"));
    await vi.advanceTimersByTimeAsync(BROWSER_READINESS_COMMAND_DRAIN_MS + 1);
    expect(await pending).toBeInstanceOf(BrowserReadinessRetirementError);
    expect(test.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns false for an error only after actual closure", async () => {
    const test = fixture();
    const pending = test.probe("display", test.controller.signal);
    test.respond(new Error("fixture failure"));
    test.child.emit("close", 1);
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a timed-out utility and ignores its late successful output", async () => {
    const test = fixture();
    test.child.kill.mockImplementation(() => {
      test.respond(null);
      test.child.emit("close", null, "SIGKILL");
      return true;
    });
    const pending = test.probe("display", test.controller.signal);
    await vi.advanceTimersByTimeAsync(501);
    expect(await pending).toBe(false);
    expect(test.child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a late success if a timed-out process never closes", async () => {
    const test = fixture();
    const pending = test.probe("display", test.controller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(501);
    test.respond(null);
    await vi.advanceTimersByTimeAsync(BROWSER_READINESS_COMMAND_DRAIN_MS);
    expect(await pending).toBeInstanceOf(BrowserReadinessRetirementError);
  });

  it("allocates no utility for a pre-cancelled probe", async () => {
    const test = fixture();
    test.controller.abort();
    expect(await test.probe("display", test.controller.signal)).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("bounds a synchronous error emitted by the kill request without retry recursion", async () => {
    const test = fixture();
    test.child.kill.mockImplementation(() => {
      test.child.emit("error", new Error("fixture kill failure"));
      return false;
    });
    const pending = test.probe("display", test.controller.signal).catch((error: unknown) => error);
    test.respond(new Error("fixture command failure"));
    await vi.advanceTimersByTimeAsync(BROWSER_READINESS_COMMAND_DRAIN_MS + 1);
    expect(await pending).toBeInstanceOf(BrowserReadinessRetirementError);
    expect(test.child.kill).toHaveBeenCalledOnce();
  });

  it("does not let an earlier closed failure poison a subsequent readiness attempt", async () => {
    const test = fixture();
    const failed = test.probe("display", test.controller.signal);
    test.respond(new Error("fixture failure"));
    test.child.emit("close", 1);
    expect(await failed).toBe(false);
    const next = test.probe("windowManager", test.controller.signal);
    test.respond(null, "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x123");
    test.child.emit("close", 0);
    expect(await next).toBe(true);
  });
});
