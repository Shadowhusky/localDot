import { LAST_DAY, type RoutineSchedule } from "./routines.ts";

// When a routine runs: its rules, read on one clock between two local dates, both inclusive.
export interface RoutineTiming {
  readonly schedules: readonly RoutineSchedule[];
  readonly tz: string;
  // Every "every N" counts from here.
  readonly start: string;
  readonly until?: string | null;
}
export interface CalendarDate {
  y: number;
  m: number;
  d: number;
}
export interface LocalParts extends CalendarDate {
  hh: number;
  mm: number;
  ss: number;
  weekday: number;
}
const DAY_MS = 86_400_000;
const DAY_MINUTES = 1440;
// Long enough for a leap day that comes round every four years.
const DAY_SCAN_LIMIT = 1500;
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
const key = (date: CalendarDate, hh: number, mm: number) => `${dateKey(date)} ${hh}:${mm}`;
export function dateKey(date: CalendarDate): string {
  return `${String(date.y).padStart(4, "0")}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
}
export function parseDateKey(value: string): CalendarDate {
  const [y, m, d] = value.split("-").map(Number);
  return { y: y as number, m: m as number, d: d as number };
}
function addDays(date: CalendarDate, days: number): CalendarDate {
  const value = new Date(Date.UTC(date.y, date.m - 1, date.d) + days * DAY_MS);
  return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
}
export function localDateOf(ms: number, tz: string): string {
  return dateKey(localParts(ms, tz));
}

export function zonedToUtc(date: CalendarDate, hh: number, mm: number, tz: string): number {
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

const minuteOf = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return (h as number) * 60 + (m as number);
};
const dayNumber = (date: CalendarDate) => Date.UTC(date.y, date.m - 1, date.d) / DAY_MS;
const weekdayOf = (date: CalendarDate) =>
  new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
const mondayWeek = (date: CalendarDate) =>
  Math.floor((dayNumber(date) - ((weekdayOf(date) + 6) % 7)) / 7);
const monthLength = (date: CalendarDate) => new Date(Date.UTC(date.y, date.m, 0)).getUTCDate();

function minutesOn(rule: RoutineSchedule, date: CalendarDate, start: CalendarDate): number[] {
  const weekday = weekdayOf(date);
  switch (rule.unit) {
    case "minute":
    case "hour": {
      if (rule.weekdays && !rule.weekdays.includes(weekday)) return [];
      const step = rule.unit === "hour" ? rule.every * 60 : rule.every;
      const last = rule.to === undefined ? DAY_MINUTES - 1 : minuteOf(rule.to);
      const out: number[] = [];
      for (let at = minuteOf(rule.from ?? "00:00"); at <= last; at += step) out.push(at);
      return out;
    }
    case "day":
      if ((dayNumber(date) - dayNumber(start)) % rule.every !== 0) return [];
      if (rule.weekdays && !rule.weekdays.includes(weekday)) return [];
      break;
    case "week":
      if ((mondayWeek(date) - mondayWeek(start)) % rule.every !== 0) return [];
      if (!(rule.weekdays ?? [weekdayOf(start)]).includes(weekday)) return [];
      break;
    case "month": {
      if (((date.y - start.y) * 12 + (date.m - start.m)) % rule.every !== 0) return [];
      const days = rule.monthDays ?? [start.d];
      if (!days.includes(date.d) && !(days.includes(LAST_DAY) && date.d === monthLength(date)))
        return [];
      break;
    }
  }
  return (rule.times ?? []).map(minuteOf);
}

// In order, once each, however many rules land on the same moment. A wall time the clocks skip runs
// the same distance after the gap; one they repeat runs the first time only.
function instantsOn(timing: RoutineTiming, date: CalendarDate, start: CalendarDate): number[] {
  const minutes = new Set(timing.schedules.flatMap((rule) => minutesOn(rule, date, start)));
  if (!minutes.size) return [];
  const midnight = Date.UTC(date.y, date.m - 1, date.d);
  const before = offsetAt(midnight - DAY_MS, timing.tz);
  // A run every few minutes has hundreds of slots: only a day beside a clock change needs each one
  // looked up.
  const steady = before === offsetAt(midnight + 2 * DAY_MS, timing.tz);
  return [...minutes]
    .map((minute) =>
      steady
        ? midnight + minute * 60_000 - before
        : zonedToUtc(date, Math.floor(minute / 60), minute % 60, timing.tz),
    )
    .sort((a, b) => a - b);
}

function* dueAfter(timing: RoutineTiming, afterMs: number): Generator<number> {
  const start = parseDateKey(timing.start);
  // From the day before: a slot the clocks moved past midnight belongs to its own date.
  let date = addDays(localParts(afterMs, timing.tz), -1);
  if (dayNumber(date) < dayNumber(start)) date = start;
  let last = afterMs;
  for (let empty = 0; empty < DAY_SCAN_LIMIT; date = addDays(date, 1)) {
    if (timing.until && dateKey(date) > timing.until) return;
    empty++;
    for (const instant of instantsOn(timing, date, start)) {
      if (instant <= last) continue;
      last = instant;
      empty = 0;
      yield instant;
    }
  }
}

/** The first due instant strictly after `afterMs`, or null when the schedule has ended. */
export function nextDue(timing: RoutineTiming, afterMs: number): number | null {
  for (const instant of dueAfter(timing, afterMs)) return instant;
  return null;
}

export function dueTimesBetween(
  timing: RoutineTiming,
  fromExclusiveMs: number,
  toInclusiveMs: number,
  max = 10_000,
): number[] {
  const out: number[] = [];
  for (const instant of dueAfter(timing, fromExclusiveMs)) {
    if (instant > toInclusiveMs || out.length === max) break;
    out.push(instant);
  }
  return out;
}

export function nextRuns(timing: RoutineTiming, afterMs: number, count: number): number[] {
  const out: number[] = [];
  for (const instant of dueAfter(timing, afterMs)) {
    out.push(instant);
    if (out.length === count) break;
  }
  return out;
}

const WEEKDAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];
// The most a routine's summary may say.
const SUMMARY_CHARS = 200;
const list = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const clock = (time: string) => time.replace(/^0(\d:)/, "$1");
const ordinal = (day: number) => {
  if (day === LAST_DAY) return "the last day";
  const tail = day % 10;
  const suffix =
    day >= 11 && day <= 13
      ? "th"
      : tail === 1
        ? "st"
        : tail === 2
          ? "nd"
          : tail === 3
            ? "rd"
            : "th";
  return `the ${day}${suffix}`;
};
const every = (rule: RoutineSchedule) =>
  rule.every === 1 ? `Every ${rule.unit}` : `Every ${rule.every} ${rule.unit}s`;

function dayNames(weekdays: readonly number[]): string {
  const days = [...weekdays].sort((a, b) => a - b).join();
  if (days === "1,2,3,4,5") return "weekdays";
  if (days === "0,6") return "weekends";
  // Monday first, the way a week reads.
  const week = [...weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return list(week.map((day) => WEEKDAY_NAMES[day] as string));
}
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const allWeek = (weekdays: readonly number[] | undefined) => weekdays?.length === 7;

function describeRule(rule: RoutineSchedule): string {
  const times = list((rule.times ?? []).map(clock));
  switch (rule.unit) {
    case "minute":
    case "hour": {
      const on = rule.weekdays && !allWeek(rule.weekdays) ? ` on ${dayNames(rule.weekdays)}` : "";
      const from = rule.from && rule.from !== "00:00" ? rule.from : undefined;
      const span =
        from && rule.to
          ? ` from ${clock(from)} to ${clock(rule.to)}`
          : from
            ? ` from ${clock(from)}`
            : rule.to
              ? ` until ${clock(rule.to)}`
              : "";
      return `${every(rule)}${on}${span}`;
    }
    case "day":
      if (rule.every === 1)
        return rule.weekdays && !allWeek(rule.weekdays)
          ? `${capital(dayNames(rule.weekdays))} at ${times}`
          : `Every day at ${times}`;
      return rule.weekdays && !allWeek(rule.weekdays)
        ? `${every(rule)} on ${dayNames(rule.weekdays)} at ${times}`
        : `${every(rule)} at ${times}`;
    case "week":
      if (!rule.weekdays) return `${every(rule)} at ${times}`;
      if (rule.every === 1)
        return allWeek(rule.weekdays)
          ? `Every day at ${times}`
          : `${capital(dayNames(rule.weekdays))} at ${times}`;
      return `${every(rule)} on ${dayNames(rule.weekdays)} at ${times}`;
    case "month": {
      const days = [...(rule.monthDays ?? [])].sort(
        (a, b) => (a === LAST_DAY ? 32 : a) - (b === LAST_DAY ? 32 : b),
      );
      return days.length
        ? `${every(rule)} on ${list(days.map(ordinal))} at ${times}`
        : `${every(rule)} at ${times}`;
    }
  }
}

const shownDate = (value: string, now: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(value.slice(0, 4) === localDateOf(now, tz).slice(0, 4) ? {} : { year: "numeric" }),
  }).format(new Date(`${value}T00:00:00Z`));

export const zoneText = (tz: string) =>
  tz === "UTC" || tz === "Etc/UTC"
    ? "UTC"
    : `${(tz.split("/").at(-1) ?? tz).replaceAll("_", " ")} time`;

// One day and one plain daily rule: what a routine that runs once looks like.
export const isOneOff = (timing: RoutineTiming) => {
  const [rule, other] = timing.schedules;
  return (
    !other &&
    timing.start === timing.until &&
    rule?.unit === "day" &&
    rule.every === 1 &&
    !rule.weekdays
  );
};

/** In plain words: "Weekdays at 9:00 and 17:00, from 10 Nov · London time". A start date that has
 * come says nothing, so a routine that has been running reads as its rules alone. */
export function describeSchedules(timing: RoutineTiming, now: number): string {
  const zone = ` · ${zoneText(timing.tz)}`;
  if (isOneOff(timing)) {
    const times = timing.schedules[0]?.times ?? [];
    return `${times.length > 1 ? "On" : "Once on"} ${shownDate(timing.start, now, timing.tz)} at ${list(times.map(clock))}${zone}`;
  }
  const dates = [
    timing.start > localDateOf(now, timing.tz)
      ? `, from ${shownDate(timing.start, now, timing.tz)}`
      : "",
    timing.until ? ` until ${shownDate(timing.until, now, timing.tz)}` : "",
  ].join("");
  const rules = timing.schedules.map(describeRule);
  const fits = (shown: number) => {
    const left = rules.length - shown;
    return `${rules.slice(0, shown).join("; ")}${left ? ` and ${left} more` : ""}${dates}${zone}`;
  };
  let shown = rules.length;
  while (shown > 1 && fits(shown).length > SUMMARY_CHARS) shown--;
  return fits(shown).slice(0, SUMMARY_CHARS);
}
