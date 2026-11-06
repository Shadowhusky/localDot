import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextDue, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../sqlite.ts";
import { parseRule } from "./recurrence.ts";
import { RoutineStore, scheduleOf, toRoutine } from "./store.ts";

// The schema and the evaluator as they stood before schedules, kept here as the oracle: a migrated
// routine must fall due at the very moments these say.
const OLD_SCHEMA = `
CREATE TABLE routines(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, instruction TEXT NOT NULL,
  schedule_json TEXT NOT NULL, tz TEXT NOT NULL, end_at TEXT, anchor TEXT NOT NULL,
  profile TEXT NOT NULL, notify TEXT NOT NULL, approval_window_s INTEGER NOT NULL,
  budget_usd REAL, missed_policy TEXT NOT NULL, state TEXT NOT NULL,
  paused_reason TEXT, revision INTEGER NOT NULL, next_due_at INTEGER,
  created_from_session TEXT, follow_up_json TEXT, last_seen_at INTEGER,
  absence_asked_at INTEGER, last_result_hash TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE routine_runs(
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, due_at INTEGER NOT NULL,
  started_at INTEGER, ended_at INTEGER, session_id TEXT, outcome TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '');`;

type OldWhen =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "hours"; every: number; from?: string }
  | { kind: "custom"; rule: string };
interface Day {
  y: number;
  m: number;
  d: number;
}
const DAY_MS = 86_400_000;
function parts(ms: number, tz: string) {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms)))
    values[part.type] = part.value;
  return {
    y: Number(values.year),
    m: Number(values.month),
    d: Number(values.day),
    hh: Number(values.hour),
    mm: Number(values.minute),
    ss: Number(values.second),
  };
}
const offsetAt = (ms: number, tz: string) => {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
};
const dayKey = (day: Day) =>
  `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
function oldZonedToUtc(day: Day, hh: number, mm: number, tz: string): number {
  const wall = Date.UTC(day.y, day.m - 1, day.d, hh, mm);
  const offsets = new Set([
    offsetAt(wall - DAY_MS, tz),
    offsetAt(wall, tz),
    offsetAt(wall + DAY_MS, tz),
  ]);
  const exact = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => {
      const p = parts(instant, tz);
      return dayKey(p) === dayKey(day) && p.hh === hh && p.mm === mm;
    });
  return exact.length ? Math.min(...exact) : wall - Math.min(...offsets);
}
const nextDay = (day: Day): Day => {
  const value = new Date(Date.UTC(day.y, day.m - 1, day.d) + DAY_MS);
  return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
};
const hm = (value: string) => value.split(":").map(Number) as [number, number];
const dayNumber = (day: Day) => Date.UTC(day.y, day.m - 1, day.d) / DAY_MS;
const weekdayOf = (day: Day) => new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
const monday = (day: Day) => Math.floor((dayNumber(day) - ((weekdayOf(day) + 6) % 7)) / 7);
function oldTimesOn(when: OldWhen, day: Day, anchor: string): [number, number][] {
  const weekday = weekdayOf(day);
  switch (when.kind) {
    case "once":
      return dayKey(day) === when.date ? [hm(when.time)] : [];
    case "daily":
      return [hm(when.time)];
    case "weekdays":
      return weekday >= 1 && weekday <= 5 ? [hm(when.time)] : [];
    case "weekly":
      return when.days.includes(weekday) ? [hm(when.time)] : [];
    case "hours": {
      const [h0, m0] = hm(when.from ?? "00:00");
      const out: [number, number][] = [];
      for (let h = h0; h < 24; h += when.every) out.push([h, m0]);
      return out;
    }
    case "custom": {
      const rule = parseRule(when.rule);
      const [y, m, d] = anchor.split("-").map(Number) as [number, number, number];
      const first = { y, m, d };
      if (dayNumber(day) < dayNumber(first)) return [];
      const matches =
        rule.freq === "DAILY"
          ? (dayNumber(day) - dayNumber(first)) % rule.interval === 0 &&
            (!rule.byDay || rule.byDay.includes(weekday))
          : rule.freq === "WEEKLY"
            ? (monday(day) - monday(first)) % rule.interval === 0 &&
              (rule.byDay ?? [weekdayOf(first)]).includes(weekday)
            : ((day.y - first.y) * 12 + (day.m - first.m)) % rule.interval === 0 &&
              (rule.byMonthDay ?? [first.d]).includes(day.d);
      return matches ? rule.byHour.map((h) => [h, rule.byMinute] as [number, number]) : [];
    }
  }
}
function oldNextDue(
  when: OldWhen,
  tz: string,
  until: string | null,
  anchor: string,
  after: number,
): number | null {
  let day: Day = parts(after, tz);
  for (let i = 0; i < 800; i++, day = nextDay(day)) {
    const today = dayKey(day);
    if (until && today > until) return null;
    if (when.kind === "once" && today > when.date) return null;
    for (const [hh, mm] of oldTimesOn(when, day, anchor)) {
      const instant = oldZonedToUtc(day, hh, mm, tz);
      if (instant > after) return instant;
    }
  }
  return null;
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});
const CREATED = "2026-01-05";
const NOW = Date.parse("2026-01-05T12:00:00Z");
interface Seed {
  when: unknown;
  tz?: string;
  until?: string | null;
  state?: string;
  nextDueAt?: number | null;
  revision?: number;
}
function oldHome(seeds: Seed[]) {
  const home = mkdtempSync(join(tmpdir(), "ld-migrate-"));
  const db = new DatabaseSync(join(home, "routines.sqlite"));
  db.exec(OLD_SCHEMA);
  const ids = seeds.map((seed) => {
    const id = ulid();
    db.prepare(
      `INSERT INTO routines(id, kind, name, instruction, schedule_json, tz, end_at, anchor, profile,
        notify, approval_window_s, budget_usd, missed_policy, state, paused_reason, revision,
        next_due_at, created_from_session, follow_up_json, last_seen_at, absence_asked_at,
        last_result_hash, created_at, updated_at)
       VALUES(?, 'routine', 'R', 'do it', ?, ?, ?, ?, 'ask_first', 'changes', 3600, NULL, 'run_once',
        ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      id,
      typeof seed.when === "string" ? seed.when : JSON.stringify(seed.when),
      seed.tz ?? "Europe/London",
      seed.until ?? null,
      CREATED,
      seed.state ?? "active",
      seed.revision ?? 1,
      seed.nextDueAt ?? null,
      NOW,
      NOW,
    );
    return id;
  });
  db.close();
  const store = new RoutineStore(home, { now: () => NOW, zone: () => "Europe/London" });
  cleanup.push(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, store, ids };
}

const OLD_RULES: [string, OldWhen][] = [
  ["daily", { kind: "daily", time: "08:30" }],
  ["a time in a skipped hour", { kind: "daily", time: "01:30" }],
  ["another skipped hour", { kind: "daily", time: "02:30" }],
  ["weekdays", { kind: "weekdays", time: "09:00" }],
  ["chosen days", { kind: "weekly", days: [0, 3, 6], time: "17:45" }],
  ["every hour", { kind: "hours", every: 1 }],
  ["every 4 hours from a time", { kind: "hours", every: 4, from: "09:15" }],
  ["every 6 hours from a time", { kind: "hours", every: 6, from: "08:00" }],
  ["every 12 hours", { kind: "hours", every: 12 }],
  ["a one-off", { kind: "once", date: "2026-07-14", time: "15:00" }],
  ["a one-off in a skipped hour", { kind: "once", date: "2026-03-29", time: "01:30" }],
  ["a custom week", { kind: "custom", rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,FR;BYHOUR=8,18" }],
  ["a custom day", { kind: "custom", rule: "FREQ=DAILY;INTERVAL=3;BYHOUR=6;BYMINUTE=30" }],
  ["a custom filtered day", { kind: "custom", rule: "FREQ=DAILY;BYDAY=SA,SU;BYHOUR=11" }],
  ["a custom month", { kind: "custom", rule: "FREQ=MONTHLY;BYMONTHDAY=31,1;BYHOUR=7" }],
  ["a custom second month", { kind: "custom", rule: "FREQ=MONTHLY;INTERVAL=2;BYHOUR=7" }],
  ["a custom default week", { kind: "custom", rule: "FREQ=WEEKLY;BYHOUR=7" }],
];

describe("moving routines onto schedules", () => {
  describe.each(["Europe/London", "America/New_York", "Asia/Kolkata"])("in %s", (tz) => {
    it.each(OLD_RULES)("%s falls due exactly when it did", (_name, when) => {
      const { store, ids } = oldHome([{ when, tz }]);
      const routine = store.get(ids[0] as string);
      if (!routine) throw new Error("gone");
      let oldCursor = NOW;
      let newCursor = NOW;
      for (let i = 0; i < 400; i++) {
        const before = oldNextDue(when, tz, null, CREATED, oldCursor);
        const after = nextDue(scheduleOf(routine), newCursor);
        expect(after).toBe(before);
        if (before === null || after === null) break;
        oldCursor = before;
        newCursor = after;
      }
    });
  });

  it("keeps an end date", () => {
    const when: OldWhen = { kind: "daily", time: "08:30" };
    const { store, ids } = oldHome([{ when, until: "2026-01-07" }]);
    const routine = store.get(ids[0] as string);
    expect(routine?.until).toBe("2026-01-07");
    if (!routine) throw new Error("gone");
    expect(nextDue(scheduleOf(routine), Date.parse("2026-01-07T09:00:00Z"))).toBeNull();
  });

  it("keeps a one-off whose end date came first from ever running", () => {
    const { store, ids } = oldHome([
      { when: { kind: "once", date: "2026-07-14", time: "15:00" }, until: "2026-07-01" },
    ]);
    const routine = store.get(ids[0] as string);
    if (!routine) throw new Error("gone");
    expect(nextDue(scheduleOf(routine), NOW)).toBeNull();
  });

  it("leaves the due time already planned, the revision and the state alone", () => {
    const due = Date.parse("2026-01-06T08:30:00Z");
    const { store, ids } = oldHome([
      { when: { kind: "daily", time: "08:30" }, nextDueAt: due, revision: 7, state: "paused" },
    ]);
    expect(store.get(ids[0] as string)).toMatchObject({
      nextDueAt: due,
      revision: 7,
      state: "paused",
      start: CREATED,
      schedules: [{ every: 1, unit: "day", times: ["08:30"] }],
    });
  });

  it("reads as what it does, with a one-off still a one-off", () => {
    const { store, ids } = oldHome([
      { when: { kind: "weekdays", time: "09:00" } },
      { when: { kind: "once", date: "2026-07-14", time: "15:00" } },
      { when: { kind: "hours", every: 4, from: "08:00" } },
    ]);
    expect(
      ids.map((id) => {
        const routine = store.get(id);
        return routine && toRoutine(routine, undefined, NOW).summary;
      }),
    ).toEqual([
      "Weekdays at 9:00 · London time",
      "Once on 14 Jul at 15:00 · London time",
      "Every 4 hours from 8:00 · London time",
    ]);
  });

  it("pauses what could never run, so one bad rule never hides the list", () => {
    const { store, ids } = oldHome([
      { when: { kind: "custom", rule: "FREQ=HOURLY;BYHOUR=9" } },
      { when: "not json" },
      { when: { kind: "daily", time: "08:30" } },
    ]);
    expect(store.list()).toHaveLength(3);
    expect(store.get(ids[0] as string)).toMatchObject({ state: "paused", pausedReason: "user" });
    expect(store.get(ids[1] as string)).toMatchObject({ state: "paused", pausedReason: "user" });
    expect(store.get(ids[2] as string)?.state).toBe("active");
  });

  it("runs once: a second opening changes nothing", () => {
    const { home, store, ids } = oldHome([{ when: { kind: "daily", time: "08:30" } }]);
    const again = new RoutineStore(home, { now: () => NOW, zone: () => "Europe/London" });
    expect(again.get(ids[0] as string)).toEqual(store.get(ids[0] as string));
    again.close();
  });
});
