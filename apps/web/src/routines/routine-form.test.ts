import { describe, expect, it } from "vitest";
import { draftFromForm, formFromRoutine } from "./routine-form.ts";

const now = Date.parse("2026-10-12T09:00:00Z");
const fresh = () => ({
  ...formFromRoutine(null, "Europe/London", now),
  name: "Bills",
  instruction: "Check bills",
});

describe("routine form", () => {
  it("starts with plain defaults and no spending limit", () => {
    expect(formFromRoutine(null, "Europe/London", now)).toMatchObject({
      kind: "weekdays",
      time: "09:00",
      date: "2026-10-12",
      profile: "ask_first",
      notify: "changes",
      missedPolicy: "run_once",
      windowMinutes: "60",
      limited: false,
    });
    const result = draftFromForm(fresh());
    expect(result.ok && result.draft.budgetUSD).toBeNull();
  });
  it.each([
    [
      { kind: "daily", time: "08:30" },
      { kind: "daily", time: "08:30" },
    ],
    [
      { kind: "weekly", time: "09:00", days: [4, 1] },
      { kind: "weekly", days: [1, 4], time: "09:00" },
    ],
    [
      { kind: "hours", every: "4", time: "09:00" },
      { kind: "hours", every: 4, from: "09:00" },
    ],
    [
      { kind: "hours", every: "1", time: "00:00" },
      { kind: "hours", every: 1 },
    ],
    [
      { kind: "once", date: "2026-10-12", time: "15:00" },
      { kind: "once", date: "2026-10-12", time: "15:00" },
    ],
    [
      { kind: "custom", rule: " FREQ=WEEKLY;BYDAY=MO;BYHOUR=9 " },
      { kind: "custom", rule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9" },
    ],
  ])("builds the schedule %j", (fields, when) => {
    const result = draftFromForm({ ...fresh(), ...fields } as never);
    expect(result.ok && result.draft.when).toEqual(when);
  });
  it("shows every problem at once", () => {
    const result = draftFromForm({
      ...fresh(),
      name: "",
      instruction: " ",
      kind: "weekly",
      days: [],
      limited: true,
      budget: "0",
      ends: true,
      until: "",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual([
      "budget",
      "days",
      "instruction",
      "name",
      "until",
    ]);
  });
  it("round-trips a saved routine", () => {
    const saved = {
      name: "Prices",
      instruction: "Check fares",
      when: { kind: "hours", every: 4, from: "08:00" },
      until: "2026-12-31",
      profile: "read_only",
      notify: "always",
      missedPolicy: "skip",
      approvalWindowMinutes: 30,
      budgetUSD: 1.5,
    } as const;
    const result = draftFromForm(formFromRoutine(saved, "Europe/London", now));
    expect(result.ok && result.draft).toEqual(saved);
  });
  it("refuses a one-off whose time has passed, unless an edit leaves it as it was", () => {
    const clock = { tz: "Europe/London", now };
    const passed = { ...fresh(), kind: "once", date: "2026-10-12", time: "10:00" } as const;
    const result = draftFromForm(passed, clock);
    expect(!result.ok && result.errors.time).toBe("That time has passed. Pick a later one.");
    expect(draftFromForm({ ...passed, time: "10:01" }, clock).ok).toBe(true);
    const saved = { kind: "once", date: "2026-10-12", time: "10:00" } as const;
    expect(draftFromForm(passed, { ...clock, saved }).ok).toBe(true);
  });
});
