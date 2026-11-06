import {
  ClockTime,
  LocalDate,
  type RoutineSchedule,
  RoutineSchedules,
  type RoutineTiming,
} from "@localdot/protocol";
import { z } from "zod";
import type { DatabaseSync } from "../sqlite.ts";
import { parseRule, type Rule } from "./recurrence.ts";

// What routines were written as before they held several schedules.
const LegacyWhen = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), date: LocalDate, time: ClockTime }),
  z.strictObject({ kind: z.literal("daily"), time: ClockTime }),
  z.strictObject({ kind: z.literal("weekdays"), time: ClockTime }),
  z.strictObject({
    kind: z.literal("weekly"),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    time: ClockTime,
  }),
  z.strictObject({
    kind: z.literal("hours"),
    every: z.number().int().positive(),
    from: ClockTime.optional(),
  }),
  z.strictObject({ kind: z.literal("custom"), rule: z.string().min(1).max(256) }),
]);
type LegacyWhen = z.infer<typeof LegacyWhen>;
export const SCHEDULES_VERSION = 1;

const clock = (hour: number, minute: number) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
const UNIT: Record<Rule["freq"], RoutineSchedule["unit"]> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
};
function fromRule(text: string): RoutineSchedule {
  const rule = parseRule(text);
  return {
    every: rule.interval,
    unit: UNIT[rule.freq],
    times: rule.byHour.map((hour) => clock(hour, rule.byMinute)),
    ...(rule.byDay ? { weekdays: [...rule.byDay] } : {}),
    ...(rule.byMonthDay ? { monthDays: [...rule.byMonthDay] } : {}),
  };
}

type Migrated = Pick<RoutineTiming, "start" | "until"> & { schedules: RoutineSchedule[] };

// The same due times as the old rules: each ran from the day it was created, which `anchor` holds,
// and a run every few hours was already counted afresh from `from` each day.
export function fromLegacy(when: LegacyWhen, anchor: string, until: string | null): Migrated {
  const repeat = (rule: RoutineSchedule): Migrated => ({
    schedules: [rule],
    start: anchor,
    until,
  });
  switch (when.kind) {
    case "once":
      return {
        schedules: [{ every: 1, unit: "day", times: [when.time] }],
        start: when.date,
        until: until && until < when.date ? until : when.date,
      };
    case "daily":
      return repeat({ every: 1, unit: "day", times: [when.time] });
    case "weekdays":
      return repeat({ every: 1, unit: "week", weekdays: [1, 2, 3, 4, 5], times: [when.time] });
    case "weekly":
      return repeat({ every: 1, unit: "week", weekdays: [...when.days], times: [when.time] });
    case "hours":
      return repeat({
        every: when.every,
        unit: "hour",
        ...(when.from ? { from: when.from } : {}),
      });
    case "custom":
      return repeat(fromRule(when.rule));
  }
}

interface LegacyRow {
  id: string;
  schedule_json: string;
  anchor: string;
  end_at: string | null;
  state: string;
}

// Runs once per home, in one transaction. Due times already planned stay as they are, and no
// revision moves: a device reading the list sees the same routine in its new words.
export function migrateSchedules(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (version >= SCHEDULES_VERSION) return;
  const write = db.prepare(
    `UPDATE routines SET schedule_json = ?, anchor = ?, end_at = ?, state = ?,
       paused_reason = CASE WHEN ? THEN 'user' ELSE paused_reason END WHERE id = ?`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare("SELECT id, schedule_json, anchor, end_at, state FROM routines")
      .all() as unknown as LegacyRow[];
    for (const row of rows) {
      let schedules: RoutineSchedule[];
      let start = row.anchor;
      let until = row.end_at;
      let state = row.state;
      try {
        const migrated = fromLegacy(
          LegacyWhen.parse(JSON.parse(row.schedule_json)),
          row.anchor,
          row.end_at,
        );
        schedules = RoutineSchedules.parse(migrated.schedules);
        start = migrated.start;
        until = migrated.until ?? null;
      } catch {
        // A rule nothing could read never ran; it waits, paused, for the user to give it a schedule.
        schedules = [{ every: 1, unit: "day", times: ["09:00"] }];
        if (state === "active") state = "paused";
      }
      write.run(
        JSON.stringify(schedules),
        start,
        until,
        state,
        state === row.state ? 0 : 1,
        row.id,
      );
    }
    db.exec(`PRAGMA user_version = ${SCHEDULES_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
