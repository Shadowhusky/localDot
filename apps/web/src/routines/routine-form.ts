import {
  describeSchedules,
  isOneOff,
  LAST_DAY,
  localDateOf,
  nextDue,
  nextRuns,
  type Routine,
  RoutineDraft,
  type RoutineSchedule,
  type RoutineTiming,
  SCHEDULE_LIMITS,
  type ScheduleUnit,
} from "@localdot/protocol";
import { t, tr } from "../i18n/index.ts";

export interface ScheduleFormState {
  // Stays with the schedule as others come and go, for the list's keys.
  id: string;
  every: string;
  unit: ScheduleUnit;
  weekdays: number[];
  monthDays: number[];
  times: string[];
  from: string;
  to: string;
}
export interface RoutineFormState {
  name: string;
  instruction: string;
  // One date in place of the schedules.
  once: boolean;
  date: string;
  onceTimes: string[];
  schedules: ScheduleFormState[];
  start: string;
  ends: boolean;
  until: string;
  tz: string;
  profile: NonNullable<RoutineDraft["profile"]>;
  notify: NonNullable<RoutineDraft["notify"]>;
  missedPolicy: NonNullable<RoutineDraft["missedPolicy"]>;
  windowMinutes: string;
  limited: boolean;
  budget: string;
}
export interface ScheduleErrors {
  every?: string;
  days?: string;
  times?: string;
  span?: string;
}
export interface FormErrors {
  name?: string;
  instruction?: string;
  date?: string;
  times?: string;
  start?: string;
  until?: string;
  budget?: string;
  schedules?: Record<string, ScheduleErrors>;
}

export const UNITS: readonly { value: ScheduleUnit; one: string; many: string }[] = [
  { value: "minute", one: tr("minute"), many: tr("minutes") },
  { value: "hour", one: tr("hour"), many: tr("hours") },
  { value: "day", one: tr("day"), many: tr("days") },
  { value: "week", one: tr("week"), many: tr("weeks") },
  { value: "month", one: tr("month"), many: tr("months") },
];
export const WINDOWS = ["15", "30", "60", "120", "240"] as const;
// Monday first, the way a week reads.
export const WEEK: readonly { day: number; short: string; long: string }[] = [
  { day: 1, short: tr("Mon"), long: tr("Monday") },
  { day: 2, short: tr("Tue"), long: tr("Tuesday") },
  { day: 3, short: tr("Wed"), long: tr("Wednesday") },
  { day: 4, short: tr("Thu"), long: tr("Thursday") },
  { day: 5, short: tr("Fri"), long: tr("Friday") },
  { day: 6, short: tr("Sat"), long: tr("Saturday") },
  { day: 0, short: tr("Sun"), long: tr("Sunday") },
];
const WHOLE_WEEK = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const DEFAULT_TIME = "09:00";
const PREVIEW_RUNS = 5;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const blankSchedule = (id: string): ScheduleFormState => ({
  id,
  every: "1",
  unit: "week",
  weekdays: [...WEEKDAYS],
  monthDays: [1],
  times: [DEFAULT_TIME],
  from: "",
  to: "",
});

export function addedSchedule(schedules: readonly ScheduleFormState[]): ScheduleFormState {
  const used = schedules.map((schedule) => Number(schedule.id.slice(1)));
  return blankSchedule(`s${Math.max(-1, ...used) + 1}`);
}

// A step that doesn't fit the new unit starts over; minutes, hours and days start on every day.
export function withUnit(schedule: ScheduleFormState, unit: ScheduleUnit): ScheduleFormState {
  const { min, max } = SCHEDULE_LIMITS.every[unit];
  const every = Number(schedule.every);
  const narrows = (each: ScheduleUnit) => each !== "week" && each !== "month";
  return {
    ...schedule,
    unit,
    every: every >= min && every <= max ? schedule.every : unit === "minute" ? "30" : "1",
    weekdays: narrows(unit) && !narrows(schedule.unit) ? [...WHOLE_WEEK] : schedule.weekdays,
  };
}

const weekdayOfDate = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const dayOfDate = (date: string) => Number(date.slice(8));
function scheduleForm(rule: RoutineSchedule, index: number, start: string): ScheduleFormState {
  return {
    id: `s${index}`,
    every: String(rule.every),
    unit: rule.unit,
    weekdays: rule.weekdays
      ? [...rule.weekdays]
      : rule.unit === "week"
        ? [weekdayOfDate(start)]
        : [...WHOLE_WEEK],
    monthDays: rule.monthDays ? [...rule.monthDays] : [dayOfDate(start)],
    times: rule.times ? [...rule.times] : [DEFAULT_TIME],
    from: rule.from ?? "",
    to: rule.to ?? "",
  };
}

export function formFromRoutine(
  routine: Pick<
    Routine,
    | "name"
    | "instruction"
    | "schedules"
    | "tz"
    | "start"
    | "until"
    | "profile"
    | "notify"
    | "missedPolicy"
    | "approvalWindowMinutes"
    | "budgetUSD"
  > | null,
  tz: string,
  now = Date.now(),
): RoutineFormState {
  const today = localDateOf(now, tz);
  const base: RoutineFormState = {
    name: "",
    instruction: "",
    once: false,
    date: today,
    onceTimes: [DEFAULT_TIME],
    schedules: [blankSchedule("s0")],
    start: today,
    ends: false,
    until: "",
    tz,
    profile: "ask_first",
    notify: "changes",
    missedPolicy: "run_once",
    windowMinutes: "60",
    limited: false,
    budget: "",
  };
  if (!routine) return base;
  const once = isOneOff(routine);
  return {
    ...base,
    name: routine.name,
    instruction: routine.instruction,
    once,
    date: once ? routine.start : base.date,
    onceTimes: once ? [...(routine.schedules[0]?.times ?? [DEFAULT_TIME])] : base.onceTimes,
    schedules: once
      ? base.schedules
      : routine.schedules.map((rule, index) => scheduleForm(rule, index, routine.start)),
    start: routine.start,
    ends: !once && routine.until !== null,
    until: once ? "" : (routine.until ?? ""),
    tz: routine.tz,
    profile: routine.profile,
    notify: routine.notify,
    missedPolicy: routine.missedPolicy,
    windowMinutes: String(routine.approvalWindowMinutes),
    limited: routine.budgetUSD !== null,
    budget: routine.budgetUSD === null ? "" : routine.budgetUSD.toFixed(2),
  };
}

const ascending = (days: readonly number[]) => [...days].sort((a, b) => a - b);
// The last day reads last.
const monthOrder = (days: readonly number[]) =>
  [...days].sort((a, b) => (a === LAST_DAY ? 32 : a) - (b === LAST_DAY ? 32 : b));
function timesOf(times: readonly string[], errors: { times?: string }): string[] | undefined {
  if (!times.length || times.some((time) => !CLOCK.test(time))) {
    errors.times = t`Pick a time.`;
    return undefined;
  }
  return [...new Set(times)].sort();
}

function ruleOf(form: ScheduleFormState, errors: ScheduleErrors): RoutineSchedule | undefined {
  const { min, max } = SCHEDULE_LIMITS.every[form.unit];
  const every = Number(form.every);
  if (!Number.isInteger(every) || every < min || every > max)
    errors.every = t`Use a number from ${min} to ${max}.`;
  const whole = form.weekdays.length === WHOLE_WEEK.length;
  const weekdays = whole && form.unit !== "week" ? {} : { weekdays: ascending(form.weekdays) };
  if (form.unit !== "month" && !form.weekdays.length) errors.days = t`Pick at least one day.`;
  if (form.unit === "minute" || form.unit === "hour") {
    if (form.from && form.to && form.from >= form.to) errors.span = t`End after it starts.`;
    return Object.keys(errors).length
      ? undefined
      : {
          every,
          unit: form.unit,
          ...weekdays,
          ...(form.from ? { from: form.from } : {}),
          ...(form.to ? { to: form.to } : {}),
        };
  }
  const times = timesOf(form.times, errors);
  if (form.unit === "month") {
    if (!form.monthDays.length) errors.days = t`Pick at least one day.`;
    return Object.keys(errors).length || !times
      ? undefined
      : { every, unit: "month", monthDays: monthOrder(form.monthDays), times };
  }
  return Object.keys(errors).length || !times
    ? undefined
    : { every, unit: form.unit, ...weekdays, times };
}

function timingOf(form: RoutineFormState, errors: FormErrors): RoutineTiming | undefined {
  if (form.once) {
    if (!DATE.test(form.date)) errors.date = t`Pick a date.`;
    const times = timesOf(form.onceTimes, errors);
    return times && !errors.date
      ? {
          schedules: [{ every: 1, unit: "day", times }],
          tz: form.tz,
          start: form.date,
          until: form.date,
        }
      : undefined;
  }
  if (!DATE.test(form.start)) errors.start = t`Pick the first day.`;
  if (form.ends && !DATE.test(form.until)) errors.until = t`Pick the last day.`;
  else if (form.ends && form.until < form.start)
    errors.until = t`The last day can't be before the first.`;
  const schedules: RoutineSchedule[] = [];
  for (const schedule of form.schedules) {
    const problems: ScheduleErrors = {};
    const rule = ruleOf(schedule, problems);
    if (rule) schedules.push(rule);
    else errors.schedules = { ...errors.schedules, [schedule.id]: problems };
  }
  return errors.start || errors.until || errors.schedules
    ? undefined
    : { schedules, tz: form.tz, start: form.start, until: form.ends ? form.until : null };
}

export interface SchedulePreview {
  summary: string;
  runs: readonly number[];
}

// What the schedule says and when it next runs, as the form stands; null while it can't say yet.
export function previewOf(form: RoutineFormState, now: number): SchedulePreview | null {
  const timing = timingOf(form, {});
  return timing
    ? { summary: describeSchedules(timing, now), runs: nextRuns(timing, now, PREVIEW_RUNS) }
    : null;
}

// A schedule with no run left would never run. `saved` is the schedule as it is now, which an edit
// that leaves it alone may keep.
export interface FormClock {
  now: number;
  saved?: RoutineTiming;
}
const same = (a: RoutineTiming, b: RoutineTiming | undefined) =>
  !!b &&
  a.tz === b.tz &&
  a.start === b.start &&
  (a.until ?? null) === (b.until ?? null) &&
  JSON.stringify(a.schedules) === JSON.stringify(b.schedules);

// Every problem at once, keyed by field, or the draft the daemon takes.
export function draftFromForm(
  form: RoutineFormState,
  clock?: FormClock,
): { ok: true; draft: RoutineDraft } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const name = form.name.trim();
  const instruction = form.instruction.trim();
  if (!name) errors.name = t`Give the routine a name.`;
  else if (name.length > 80) errors.name = t`Keep the name under 80 characters.`;
  else if (/[\r\n]/.test(name)) errors.name = t`Keep the name on one line.`;
  if (!instruction) errors.instruction = t`Say what dot should do.`;
  const timing = timingOf(form, errors);
  if (clock && timing && !same(timing, clock.saved) && nextDue(timing, clock.now) === null) {
    if (form.once) errors.times = t`That time has passed. Pick a later one.`;
    else errors.until = t`No runs are left on those dates. Pick a later last day.`;
  }
  const budget = Number(form.budget);
  if (form.limited && !(form.budget && Number.isFinite(budget) && budget >= 0.01 && budget <= 100))
    errors.budget = t`Set an amount from $0.01 to $100.`;
  if (Object.keys(errors).length || !timing) return { ok: false, errors };
  const draft = {
    name,
    instruction,
    schedules: timing.schedules,
    tz: form.tz,
    start: timing.start,
    ...(timing.until ? { until: timing.until } : {}),
    profile: form.profile,
    notify: form.notify,
    missedPolicy: form.missedPolicy,
    approvalWindowMinutes: Number(form.windowMinutes),
    budgetUSD: form.limited ? Math.round(budget * 100) / 100 : null,
  };
  const parsed = RoutineDraft.safeParse(draft);
  if (!parsed.success) return { ok: false, errors: { name: t`This routine isn't complete yet.` } };
  return { ok: true, draft: parsed.data };
}
