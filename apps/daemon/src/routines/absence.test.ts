import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoutineAppEvent } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ABSENCE_MS, AbsenceGuard } from "./absence.ts";
import { RoutineStore } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ld-absence-"));
  let now = Date.parse("2026-10-01T07:30:00Z");
  const store = new RoutineStore(home, { now: () => now, zone: () => "Europe/London" });
  cleanup.push(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const published: RoutineAppEvent[] = [];
  const guard = new AbsenceGuard({ store, publish: (e) => published.push(e), now: () => now });
  const routine = store.create(
    { name: "Morning bills", instruction: "x", when: { kind: "daily", time: "08:30" } },
    { state: "active" },
  );
  const current = () => {
    const value = store.get(routine.id);
    if (!value) throw new Error("routine missing");
    return value;
  };
  return {
    store,
    guard,
    routine,
    current,
    published,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe("absence guard", () => {
  it("lets routines run while their results are being opened", () => {
    const f = fixture();
    f.advance(ABSENCE_MS - 60_000);
    expect(f.guard.intercept(f.current(), f.now())).toBe(false);
  });
  it("asks once after 14 days instead of running", () => {
    const f = fixture();
    f.advance(ABSENCE_MS);
    expect(f.guard.intercept(f.current(), f.now())).toBe(true);
    expect(f.store.lastRun(f.routine.id)).toMatchObject({
      outcome: "needs_you",
      note: "Asked: keep running Morning bills?",
    });
    expect(f.published.at(-1)).toMatchObject({
      notify: true,
      title: "Keep running Morning bills?",
    });
    expect(f.store.get(f.routine.id)?.absenceAskedAt).toBe(f.now());
  });
  it("pauses at the next due time when nobody answers", () => {
    const f = fixture();
    f.advance(ABSENCE_MS);
    f.guard.intercept(f.current(), f.now());
    f.advance(86_400_000);
    expect(f.guard.intercept(f.current(), f.now())).toBe(true);
    expect(f.store.get(f.routine.id)).toMatchObject({ state: "paused", pausedReason: "absence" });
  });
  it("an answer clears the question and the routine keeps running", () => {
    const f = fixture();
    f.advance(ABSENCE_MS);
    f.guard.intercept(f.current(), f.now());
    f.store.markSeen(f.routine.id, f.now());
    f.advance(86_400_000);
    expect(f.guard.intercept(f.current(), f.now())).toBe(false);
  });
});
