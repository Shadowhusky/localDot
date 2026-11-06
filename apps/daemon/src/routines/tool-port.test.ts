import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutineStore } from "./store.ts";
import { routineToolPort, scheduleFromTool } from "./tool-port.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});
const NOW = Date.parse("2026-10-12T09:00:00Z");
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ld-tool-port-"));
  const store = new RoutineStore(home, { now: () => NOW, zone: () => "Europe/London" });
  cleanup.push(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const changed = vi.fn();
  return {
    store,
    changed,
    port: routineToolPort({ store, now: () => NOW, zone: () => "Europe/London", changed }),
  };
}

describe("tool port", () => {
  it.each([
    [
      { unit: "week", days: ["mon", "thu"], times: ["09:00", "17:00"] },
      { every: 1, unit: "week", weekdays: [1, 4], times: ["09:00", "17:00"] },
    ],
    [
      { every: 4, unit: "hour", from: "09:00", to: "21:00" },
      { every: 4, unit: "hour", from: "09:00", to: "21:00" },
    ],
    [
      { every: 2, unit: "month", month_days: [1, -1], times: ["08:00"] },
      { every: 2, unit: "month", monthDays: [1, -1], times: ["08:00"] },
    ],
  ])("maps %j", (input, expected) => {
    expect(scheduleFromTool(input as never)).toEqual(expected);
  });
  const propose = (f: ReturnType<typeof fixture>, extra: object) =>
    f.port.propose(ulid(), { name: "Bills", instruction: "Check bills", schedules: [], ...extra });
  it.each([
    [[{ unit: "day" }], "Say what time it runs."],
    [[{ unit: "minute" }], "A step in minutes must be from 5 to 720."],
    [[{ every: 30, unit: "hour" }], "A step in hours must be from 1 to 23."],
    [[{ unit: "week", month_days: [1], times: ["09:00"] }], "Days of the month work with months."],
  ])("explains a schedule it cannot use: %j", (schedules, message) => {
    expect(() => propose(fixture(), { schedules })).toThrow(
      expect.objectContaining({ status: 400, message }),
    );
  });
  it("takes the same model the app does, and sums it up for the card", () => {
    const f = fixture();
    const proposal = propose(f, {
      schedules: [
        { unit: "week", days: ["mon", "tue", "wed", "thu", "fri"], times: ["09:00", "17:00"] },
        { every: 2, unit: "month", month_days: [-1], times: ["08:00"] },
      ],
      start: "2026-11-10",
      until: "2027-03-01",
    });
    expect(proposal.summary).toBe(
      "Weekdays at 9:00 and 17:00; Every 2 months on the last day at 8:00, from 10 Nov until 1 Mar 2027 · London time",
    );
    expect(f.store.get(proposal.routineId)).toMatchObject({
      start: "2026-11-10",
      until: "2027-03-01",
      schedules: [
        { every: 1, unit: "week", weekdays: [1, 2, 3, 4, 5], times: ["09:00", "17:00"] },
        { every: 2, unit: "month", monthDays: [-1], times: ["08:00"] },
      ],
    });
  });
  it("proposes a one-off as a single day", () => {
    const proposal = propose(fixture(), {
      schedules: [{ unit: "day", times: ["15:00"] }],
      start: "2026-10-20",
      until: "2026-10-20",
    });
    expect(proposal.summary).toBe("Once on 20 Oct at 15:00 · London time");
  });
  it("propose stores an inactive proposal tied to the session", () => {
    const f = fixture();
    const session = ulid();
    const proposal = f.port.propose(session, {
      name: "Bills",
      instruction: "Check bills",
      schedules: [{ unit: "day", times: ["08:30"] }],
    });
    expect(f.store.get(proposal.routineId)).toMatchObject({
      state: "proposed",
      createdFromSession: session,
    });
    expect(f.changed).toHaveBeenCalledTimes(1);
  });
  it("follow-ups must be between one minute and seven days ahead", () => {
    const f = fixture();
    const session = ulid();
    expect(() => f.port.followUp(session, "2026-10-12T10:00", "too soon")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => f.port.followUp(session, "2026-10-20T10:00", "too late")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    const ok = f.port.followUp(session, "2026-10-12T15:00", "Check the parcel");
    expect(f.store.get(ok.routineId)).toMatchObject({
      kind: "follow_up",
      state: "active",
      followUp: { sessionId: session, note: "Check the parcel" },
      schedules: [{ every: 1, unit: "day", times: ["15:00"] }],
      start: "2026-10-12",
      until: "2026-10-12",
    });
  });
  it("answers an impossible date or a two-line name in plain words", () => {
    const f = fixture();
    const session = ulid();
    const plain = (message: string) =>
      expect.objectContaining({ name: "RoutineError", status: 400, message });
    expect(() =>
      f.port.propose(session, {
        name: "Bills",
        instruction: "Check bills",
        schedules: [{ unit: "day", times: ["08:30"] }],
        until: "2026-02-30",
      }),
    ).toThrow(plain("The end date isn't a real date."));
    expect(() =>
      f.port.propose(session, {
        name: "Bills\nand more",
        instruction: "Check bills",
        schedules: [{ unit: "day", times: ["08:30"] }],
      }),
    ).toThrow(plain("A routine's name is one line of up to 80 characters."));
    expect(() => f.port.followUp(session, "2026-10-32T10:00", "x")).toThrow(
      plain("That date isn't a real date."),
    );
  });
  it("names the routine it would pause", () => {
    const f = fixture();
    const routine = f.store.create(
      {
        name: "Morning bills",
        instruction: "a",
        schedules: [{ every: 1, unit: "day", times: ["08:30"] }],
      },
      { state: "active" },
    );
    expect(f.port.name(routine.id)).toBe("Morning bills");
    expect(f.port.name(ulid())).toBeUndefined();
  });
  it("pause only pauses an active routine", () => {
    const f = fixture();
    const active = f.store.create(
      { name: "A", instruction: "a", schedules: [{ every: 1, unit: "day", times: ["08:30"] }] },
      { state: "active" },
    );
    const proposed = f.store.create(
      { name: "P", instruction: "p", schedules: [{ every: 1, unit: "day", times: ["08:30"] }] },
      { state: "proposed" },
    );
    expect(f.port.pause(proposed.id)).toBe(false);
    expect(f.port.pause(active.id)).toBe(true);
    expect(f.store.get(active.id)).toMatchObject({ state: "paused", pausedReason: "user" });
  });
});
