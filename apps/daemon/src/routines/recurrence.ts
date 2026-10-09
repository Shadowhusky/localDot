import type { LocalDate } from "./schedule.ts";

/** The message is shown to the user as is. */
export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceError";
  }
}
export interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  byDay?: readonly number[];
  byMonthDay?: readonly number[];
  byHour: readonly number[];
  byMinute: number;
}
const DAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const KEYS = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYHOUR", "BYMINUTE"];
const ints = (value: string, min: number, max: number, name: string) => {
  const out = value.split(",").map((part) => {
    if (!/^\d{1,2}$/.test(part)) throw new RecurrenceError(`${name} must be whole numbers.`);
    const n = Number(part);
    if (n < min || n > max) throw new RecurrenceError(`${name} must be between ${min} and ${max}.`);
    return n;
  });
  if (new Set(out).size !== out.length) throw new RecurrenceError(`${name} repeats a value.`);
  return out;
};

/** A small subset of RFC 5545 rules; anything else is refused with a plain sentence. */
export function parseRule(text: string): Rule {
  const body = text.trim().replace(/^RRULE:/i, "");
  if (!body || body.length > 256)
    throw new RecurrenceError("Write a rule such as FREQ=WEEKLY;BYDAY=MO;BYHOUR=9.");
  const fields = new Map<string, string>();
  for (const part of body.split(";")) {
    const [rawKey, value, extra] = part.split("=");
    const name = (rawKey ?? "").toUpperCase();
    if (!value || extra !== undefined) throw new RecurrenceError(`"${part}" is not KEY=VALUE.`);
    if (fields.has(name)) throw new RecurrenceError(`${name} appears twice.`);
    if (!KEYS.includes(name))
      throw new RecurrenceError(
        name === "UNTIL" ? "Use the end date instead of UNTIL." : `${name} is not supported here.`,
      );
    fields.set(name, value.toUpperCase());
  }
  const freq = fields.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY")
    throw new RecurrenceError("FREQ must be DAILY, WEEKLY or MONTHLY.");
  const hours = fields.get("BYHOUR");
  if (!hours) throw new RecurrenceError("Add BYHOUR so the routine has a time.");
  const byHour = ints(hours, 0, 23, "BYHOUR");
  if (byHour.length > 6) throw new RecurrenceError("BYHOUR allows at most 6 hours.");
  const minute = fields.get("BYMINUTE");
  const byMinute = minute === undefined ? [0] : ints(minute, 0, 59, "BYMINUTE");
  if (byMinute.length !== 1) throw new RecurrenceError("BYMINUTE takes one value.");
  const intervalText = fields.get("INTERVAL");
  const interval =
    intervalText === undefined ? 1 : (ints(intervalText, 1, 31, "INTERVAL")[0] as number);
  const rule: Rule = {
    freq,
    interval,
    byHour: byHour.sort((a, b) => a - b),
    byMinute: byMinute[0] as number,
  };
  const days = fields.get("BYDAY");
  if (days) {
    const byDay = days.split(",").map((day) => {
      const n = DAYS[day];
      if (n === undefined) throw new RecurrenceError("BYDAY takes MO, TU, WE, TH, FR, SA or SU.");
      return n;
    });
    if (new Set(byDay).size !== byDay.length) throw new RecurrenceError("BYDAY repeats a value.");
    rule.byDay = byDay;
  }
  const monthDays = fields.get("BYMONTHDAY");
  if (monthDays) rule.byMonthDay = ints(monthDays, 1, 31, "BYMONTHDAY");
  return rule;
}

const utcDay = (date: LocalDate) => Date.UTC(date.y, date.m - 1, date.d) / 86_400_000;
const weekday = (date: LocalDate) => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
const mondayIndex = (date: LocalDate) => Math.floor((utcDay(date) - ((weekday(date) + 6) % 7)) / 7);

/** INTERVAL counts from the anchor; weeks start on Monday; a missing month day is skipped. */
export function ruleTimes(rule: Rule, date: LocalDate, anchor: LocalDate): [number, number][] {
  if (utcDay(date) < utcDay(anchor)) return [];
  let matches: boolean;
  switch (rule.freq) {
    case "DAILY":
      matches =
        (utcDay(date) - utcDay(anchor)) % rule.interval === 0 &&
        (!rule.byDay || rule.byDay.includes(weekday(date)));
      break;
    case "WEEKLY":
      matches =
        (mondayIndex(date) - mondayIndex(anchor)) % rule.interval === 0 &&
        (rule.byDay ?? [weekday(anchor)]).includes(weekday(date));
      break;
    case "MONTHLY":
      matches =
        ((date.y - anchor.y) * 12 + (date.m - anchor.m)) % rule.interval === 0 &&
        (rule.byMonthDay ?? [anchor.d]).includes(date.d);
      break;
  }
  return matches ? rule.byHour.map((h) => [h, rule.byMinute] as [number, number]) : [];
}
