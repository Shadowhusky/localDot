import { EXPECTED_OPERATION_MS } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { CellOperations, SCREEN_MS } from "./operations.ts";
import type { CellTimings } from "./store.ts";
import { NO_STREAM } from "./types.ts";

const ID = "01JXYZ0000000000000000ABCD";
const starting = { state: "starting" as const, stream: NO_STREAM };
const stopping = { state: "stopping" as const, stream: NO_STREAM };
const ready = { state: "ready" as const, stream: NO_STREAM };
const live = { state: "ready" as const, stream: { ...NO_STREAM, connection: "live" as const } };

function setup(saved: CellTimings = {}) {
  const timings = new Map<string, CellTimings>([[ID, saved]]);
  const store = {
    timings: (id: string) => timings.get(id) ?? {},
    saveTimings: (id: string, next: CellTimings) => void timings.set(id, next),
  };
  const clock = { now: 1_000_000 };
  const ops = new CellOperations(store, () => clock.now);
  return { ops, timings, clock };
}

describe("CellOperations", () => {
  it("reports when an operation began and how long it has run, in the daemon's time", () => {
    const { ops, clock } = setup();
    ops.begin(ID, "first-start", "network");
    clock.now += 12_345;
    expect(ops.summary(ID, starting)).toEqual({
      kind: "first-start",
      step: "network",
      startedAt: 1_000_000,
      elapsedMs: 12_345,
      expectedMs: EXPECTED_OPERATION_MS["first-start"],
    });
  });

  it("moves through its steps only forward", () => {
    const { ops } = setup();
    ops.begin(ID, "update", "shutdown");
    expect(ops.step(ID, "install")).toBe(true);
    expect(ops.step(ID, "desktop")).toBe(true);
    expect(ops.step(ID, "network")).toBe(false);
    expect(ops.step(ID, "desktop")).toBe(false);
    expect(ops.summary(ID, starting)?.step).toBe("desktop");
  });

  it("keeps the clock of a start already going when another start lands", () => {
    const { ops, clock } = setup();
    ops.begin(ID, "start", "network");
    clock.now += 4000;
    ops.begin(ID, "start", "network");
    expect(ops.summary(ID, starting)).toMatchObject({ startedAt: 1_000_000, elapsedMs: 4000 });
    ops.begin(ID, "stop", "shutdown");
    expect(ops.summary(ID, stopping)).toMatchObject({ kind: "stop", elapsedMs: 0 });
  });

  it("remembers how long each finished kind took, as the next one's expected time", () => {
    const { ops, timings, clock } = setup();
    ops.begin(ID, "start", "network");
    clock.now += 8_200;
    ops.finish(ID);
    ops.begin(ID, "stop", "shutdown");
    clock.now += 2_100;
    ops.finish(ID);
    expect(timings.get(ID)).toEqual({ start: 8_200, stop: 2_100 });

    ops.begin(ID, "start", "network");
    expect(ops.summary(ID, starting)?.expectedMs).toBe(8_200);
    ops.end(ID);
    // A restart waits out its backoff before it starts as usual.
    ops.begin(ID, "restart", "network", { extraMs: 4_000 });
    expect(ops.summary(ID, starting)?.expectedMs).toBe(12_200);
  });

  it("keeps no time for a restart, a recovery or a computer that came up some other way", () => {
    const { ops, timings, clock } = setup({ start: 9_000 });
    ops.begin(ID, "restart", "network");
    clock.now += 30_000;
    ops.finish(ID);
    ops.begin(ID, "start", "ready", { timed: false });
    clock.now += 30_000;
    ops.finish(ID);
    ops.begin(ID, "start", "network");
    clock.now += 30_000;
    ops.settle(ID);
    expect(timings.get(ID)).toEqual({ start: 9_000 });
  });

  it("shows a ready computer's start on its last step until its screen is up", () => {
    const { ops, clock } = setup();
    ops.begin(ID, "start", "network");
    ops.step(ID, "ready");
    expect(ops.summary(ID, ready)).toBeUndefined();
    clock.now += 7_000;
    ops.finish(ID);
    expect(ops.summary(ID, ready)).toMatchObject({ step: "screen", elapsedMs: 7_000 });
    expect(ops.summary(ID, { ...ready, paused: true })).toBeUndefined();
    expect(ops.summary(ID, live)).toBeUndefined();
    ops.connected(ID);
    expect(ops.summary(ID, ready)).toBeUndefined();
  });

  it("lets the screen step lapse when no page connects", () => {
    const { ops, clock } = setup();
    ops.begin(ID, "start", "network");
    ops.finish(ID);
    clock.now += SCREEN_MS + 1;
    expect(ops.summary(ID, ready)).toBeUndefined();
    expect(ops.running(ID)).toBe(false);
  });

  it("ends a stop when the computer is off, with nothing left to show", () => {
    const { ops } = setup();
    ops.begin(ID, "stop", "shutdown");
    expect(ops.summary(ID, stopping)?.kind).toBe("stop");
    ops.finish(ID);
    expect(ops.running(ID)).toBe(false);
    expect(ops.summary(ID, stopping)).toBeUndefined();
  });

  it("keeps going when how long it took can't be written", () => {
    const store = {
      timings: () => ({}),
      saveTimings: () => {
        throw Object.assign(new Error("full"), { code: "ENOSPC" });
      },
    };
    const ops = new CellOperations(store);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ops.begin(ID, "stop", "shutdown");
      expect(() => ops.finish(ID)).not.toThrow();
      expect(error).toHaveBeenCalledWith(`cell ${ID}: how long it took was not kept (ENOSPC)`);
    } finally {
      error.mockRestore();
    }
  });
});
