import type { ComputerOperation } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  followOperation,
  type OperationClock,
  PROGRESS_HOLD,
  progressAt,
} from "./operation-clock.ts";
import { parseCell } from "./parse.ts";
import type { CellSummary } from "./types.ts";

const ID = "01JXYZ0000000000000000ABCD";
const STARTED = 1_780_000_000_000;
const none = { connection: "none", viewers: 0, lastUpstreamAt: null } as const;
const cell = (patch: Partial<CellSummary> = {}): CellSummary => ({
  id: ID,
  state: "starting",
  scale: 2,
  createdAt: "2026-10-09T09:00:00.000Z",
  stream: none,
  ...patch,
});
const op = (elapsedMs: number, patch: Partial<ComputerOperation> = {}): ComputerOperation => ({
  kind: "start",
  step: "ready",
  startedAt: STARTED,
  elapsedMs,
  expectedMs: 20_000,
  ...patch,
});

describe("followOperation", () => {
  it("anchors an operation where the daemon began it, on this page's clock", () => {
    expect(followOperation(null, cell({ operation: op(12_000) }), 500_000)).toEqual({
      cellId: ID,
      kind: "start",
      step: "ready",
      startedAt: STARTED,
      since: 488_000,
      expectedMs: 20_000,
    });
  });

  it("keeps its anchor as later summaries of the same operation arrive", () => {
    const first = followOperation(null, cell({ operation: op(12_000) }), 500_000);
    // The same summary sent again, a little late: the clock doesn't move.
    expect(followOperation(first, cell({ operation: op(12_000) }), 500_400)).toBe(first);
    const stepped = followOperation(
      first,
      cell({ state: "ready", operation: op(15_000, { step: "screen" }) }),
      503_250,
    );
    expect(stepped).toMatchObject({ since: 488_000, step: "screen" });
  });

  it("gives pages that load at different moments the same start", () => {
    const a = followOperation(null, cell({ operation: op(12_000) }), 500_000);
    const b = followOperation(null, cell({ operation: op(42_000) }), 530_000);
    expect(b?.since).toBe(a?.since);
  });

  it("keeps the last one while the computer is on its way and its summary says nothing", () => {
    const last = followOperation(null, cell({ operation: op(3_000) }), 10_000);
    expect(followOperation(last, null, 20_000)).toBe(last);
    expect(followOperation(last, cell(), 20_000)).toBe(last);
    expect(followOperation(last, cell({ state: "ready" }), 20_000)).toBe(last);
  });

  it("lets go once the computer has settled, or for another computer", () => {
    const last = followOperation(null, cell({ operation: op(3_000) }), 10_000);
    const live = { ...none, connection: "live" as const, viewers: 1 };
    expect(followOperation(last, cell({ state: "ready", stream: live }), 20_000)).toBeNull();
    expect(followOperation(last, cell({ state: "stopped" }), 20_000)).toBeNull();
    expect(followOperation(last, cell({ state: "failed" }), 20_000)).toBeNull();
    expect(followOperation(last, cell({ id: "01JXYZ0000000000000000ABCE" }), 20_000)).toBeNull();
  });

  it("starts again for a new operation, and never takes a step back in one", () => {
    const last = followOperation(null, cell({ operation: op(3_000, { step: "ready" }) }), 10_000);
    expect(followOperation(last, cell({ operation: op(4_000, { step: "desktop" }) }), 11_000)).toBe(
      last,
    );
    const stop = followOperation(
      last,
      cell({
        state: "stopping",
        operation: op(0, { kind: "stop", step: "shutdown", startedAt: 1 }),
      }),
      30_000,
    );
    expect(stop).toMatchObject({ kind: "stop", since: 30_000 });
  });

  it("comes from a summary the page could read", () => {
    const summary = parseCell({ ...cell(), operation: op(1_000) });
    expect(summary.operation).toEqual(op(1_000));
    expect(() => parseCell({ ...cell(), operation: { ...op(1_000), step: "booting" } })).toThrow();
  });
});

describe("progressAt", () => {
  const timing = (patch: Partial<OperationClock> = {}) => ({
    since: 0,
    expectedMs: 20_000,
    kind: "start" as const,
    ...patch,
  });

  it("moves on with the time, slowing as the expected time runs out, and holds short of full", () => {
    const at = [0, 2_000, 5_000, 10_000, 20_000, 40_000, 80_000, 600_000].map((ms) =>
      progressAt(timing(), ms),
    );
    expect(at[0]).toBe(0);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThanOrEqual(at[i - 1] as number);
    expect(at[2]).toBeGreaterThan(0.25);
    expect(at[4]).toBeGreaterThan(0.75);
    expect(at[4]).toBeLessThan(0.85);
    expect(Math.max(...at)).toBeLessThanOrEqual(PROGRESS_HOLD);
  });

  it("is nudged on by the steps the computer has reached, never past the hold", () => {
    expect(progressAt(timing({ step: "desktop" }), 0)).toBe(0.05);
    expect(progressAt(timing({ step: "ready" }), 0)).toBe(0.1);
    expect(progressAt(timing({ step: "screen" }), 0)).toBe(0.9);
    expect(progressAt(timing({ step: "screen" }), 600_000)).toBe(PROGRESS_HOLD);
    expect(progressAt(timing({ kind: "update", step: "install" }), 0)).toBe(0.1);
    expect(progressAt(timing({ kind: "stop", step: "shutdown" }), 0)).toBe(0);
  });

  it("counts a clock that starts in the future as no time at all", () => {
    expect(progressAt(timing({ since: 5_000 }), 0)).toBe(0);
  });
});
