import type { RoutineWhen } from "@localdot/protocol";
import { parseRule, RecurrenceError, ruleTimes } from "./recurrence.ts";

export interface Schedule {
  readonly when: RoutineWhen;
  readonly tz: string;
  // Inclusive local date.
  readonly until?: string | null;
  // Local creation date: a custom rule's INTERVAL counts from it.
  readonly anchor?: string;
}
export interface LocalDate {
  y: number;
  m: number;
  d: number;
}
export interface LocalParts extends LocalDate {
  hh: number;
  mm: number;
  ss: number;
  weekday: number;
}
const DAY_MS = 86_400_000;
const DAY_SCAN_LIMIT = 800;
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let value = formatters.get(tz);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, value);
  }
  return value;
}
export function localParts(ms: number, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    ss: Number(parts.second),
    weekday: WEEKDAY[parts.weekday ?? ""] ?? 0,
  };
}
function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}
const key = (date: LocalDate, hh: number, mm: number) => `${dateKey(date)} ${hh}:${mm}`;
export function dateKey(date: LocalDate): string {
  return `${String(date.y).padStart(4, "0")}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
}
export function parseDateKey(value: string): LocalDate {
  const [y, m, d] = value.split("-").map(Number);
  return { y: y as number, m: m as number, d: d as number };
}
export function addDays(date: LocalDate, days: number): LocalDate {
  const value = new Date(Date.UTC(date.y, date.m - 1, date.d) + days * DAY_MS);
  return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
}
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}
export function localDateOf(ms: number, tz: string): string {
  return dateKey(localParts(ms, tz));
}

export function zonedToUtc(date: LocalDate, hh: number, mm: number, tz: string): number {
  const wall = Date.UTC(date.y, date.m - 1, date.d, hh, mm);
  const offsets = new Set([
    offsetAt(wall - DAY_MS, tz),
    offsetAt(wall, tz),
    offsetAt(wall + DAY_MS, tz),
  ]);
  const wanted = key(date, hh, mm);
  const exact = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => {
      const p = localParts(instant, tz);
      return key(p, p.hh, p.mm) === wanted;
    });
  if (exact.length) return Math.min(...exact);
  // A skipped wall time: clocks jump forward, so the smaller offset is the one before the gap,
  // which lands the same distance after it (01:30 becomes 02:30).
  return wall - Math.min(...offsets);
}

const hm = (value: string): [number, number] => {
  const [h, m] = value.split(":").map(Number);
  return [h as number, m as number];
};
function timesOn(schedule: Schedule, date: LocalDate): [number, number][] {
  const when = schedule.when;
  const weekday = weekdayOf(date);
  switch (when.kind) {
    case "once":
      return dateKey(date) === when.date ? [hm(when.time)] : [];
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
      if (!schedule.anchor) throw new RecurrenceError("A custom schedule needs its start date.");
      return ruleTimes(parseRule(when.rule), date, parseDateKey(schedule.anchor));
    }
  }
}

/** The first due instant strictly after `afterMs`, or null when the schedule has ended. */
export function nextDue(schedule: Schedule, afterMs: number): number | null {
  const start = localParts(afterMs, schedule.tz);
  let date: LocalDate = { y: start.y, m: start.m, d: start.d };
  for (let i = 0; i < DAY_SCAN_LIMIT; i++, date = addDays(date, 1)) {
    const today = dateKey(date);
    if (schedule.until && today > schedule.until) return null;
    if (schedule.when.kind === "once" && today > schedule.when.date) return null;
    for (const [hh, mm] of timesOn(schedule, date)) {
      const instant = zonedToUtc(date, hh, mm, schedule.tz);
      if (instant > afterMs) return instant;
    }
  }
  return null;
}

export function dueTimesBetween(
  schedule: Schedule,
  fromExclusiveMs: number,
  toInclusiveMs: number,
  max = 10_000,
): number[] {
  const out: number[] = [];
  let cursor = fromExclusiveMs;
  while (out.length < max) {
    const instant = nextDue(schedule, cursor);
    if (instant === null || instant > toInclusiveMs) break;
    out.push(instant);
    cursor = instant;
  }
  return out;
}

const DAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];
const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const dateText = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
export const zoneText = (tz: string) =>
  tz === "UTC" || tz === "Etc/UTC"
    ? "UTC"
    : `${(tz.split("/").at(-1) ?? tz).replaceAll("_", " ")} time`;

export function describeSchedule(schedule: Schedule): string {
  const when = schedule.when;
  let text: string;
  switch (when.kind) {
    case "once":
      text = `Once on ${dateText(when.date)} at ${when.time}`;
      break;
    case "daily":
      text = `Every day at ${when.time}`;
      break;
    case "weekdays":
      text = `Weekdays at ${when.time}`;
      break;
    case "weekly":
      text = `${list([...when.days].sort((a, b) => a - b).map((d) => DAY_NAMES[d] as string))} at ${when.time}`;
      break;
    case "hours":
      text = when.every === 1 ? "Every hour" : `Every ${when.every} hours`;
      if (when.from && when.from !== "00:00") text += ` from ${when.from}`;
      break;
    case "custom":
      text = `Custom (${when.rule})`;
      break;
  }
  if (schedule.until) text += ` until ${dateText(schedule.until)}`;
  return `${text} · ${zoneText(schedule.tz)}`;
}
