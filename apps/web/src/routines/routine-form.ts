import { HOUR_STEPS, type Routine, RoutineDraft, type RoutineWhen } from "@localdot/protocol";

export type WhenKind = RoutineWhen["kind"];
export interface RoutineFormState {
  name: string;
  instruction: string;
  kind: WhenKind;
  time: string;
  date: string;
  days: number[];
  every: string;
  rule: string;
  ends: boolean;
  until: string;
  profile: NonNullable<RoutineDraft["profile"]>;
  notify: NonNullable<RoutineDraft["notify"]>;
  missedPolicy: NonNullable<RoutineDraft["missedPolicy"]>;
  windowMinutes: string;
  limited: boolean;
  budget: string;
}
export type FormErrors = Partial<Record<keyof RoutineFormState, string>>;

export const WHEN_KINDS: readonly { value: WhenKind; label: string }[] = [
  { value: "weekdays", label: "Weekdays" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "On chosen days" },
  { value: "hours", label: "Every few hours" },
  { value: "once", label: "Once" },
  { value: "custom", label: "Custom rule" },
];
export const WINDOWS = ["15", "30", "60", "120", "240"] as const;
export const EVERY = HOUR_STEPS.map(String);
// Monday first, the way a week reads.
export const WEEK: readonly { day: number; short: string; long: string }[] = [
  { day: 1, short: "Mon", long: "Monday" },
  { day: 2, short: "Tue", long: "Tuesday" },
  { day: 3, short: "Wed", long: "Wednesday" },
  { day: 4, short: "Thu", long: "Thursday" },
  { day: 5, short: "Fri", long: "Friday" },
  { day: 6, short: "Sat", long: "Saturday" },
  { day: 0, short: "Sun", long: "Sunday" },
];

// The local "YYYY-MM-DDTHH:MM" of an instant, which orders like the instant itself.
const localMinute = (tz: string, now: number) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(now))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
const today = (tz: string, now: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

export function formFromRoutine(
  routine: Pick<
    Routine,
    | "name"
    | "instruction"
    | "when"
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
  const base: RoutineFormState = {
    name: "",
    instruction: "",
    kind: "weekdays",
    time: "09:00",
    date: today(tz, now),
    days: [1],
    every: "4",
    rule: "",
    ends: false,
    until: "",
    profile: "ask_first",
    notify: "changes",
    missedPolicy: "run_once",
    windowMinutes: "60",
    limited: false,
    budget: "",
  };
  if (!routine) return base;
  const when = routine.when;
  return {
    ...base,
    name: routine.name,
    instruction: routine.instruction,
    kind: when.kind,
    time:
      when.kind === "hours"
        ? (when.from ?? "00:00")
        : when.kind === "custom"
          ? base.time
          : when.time,
    date: when.kind === "once" ? when.date : base.date,
    days: when.kind === "weekly" ? [...when.days] : base.days,
    every: when.kind === "hours" ? String(when.every) : base.every,
    rule: when.kind === "custom" ? when.rule : "",
    ends: routine.until !== null,
    until: routine.until ?? "",
    profile: routine.profile,
    notify: routine.notify,
    missedPolicy: routine.missedPolicy,
    windowMinutes: String(routine.approvalWindowMinutes),
    limited: routine.budgetUSD !== null,
    budget: routine.budgetUSD === null ? "" : routine.budgetUSD.toFixed(2),
  };
}

function whenOf(form: RoutineFormState, errors: FormErrors): RoutineWhen | undefined {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(form.time) ? form.time : undefined;
  if (form.kind !== "custom" && !time) errors.time = "Pick a time.";
  switch (form.kind) {
    case "once":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) errors.date = "Pick a date.";
      return time ? { kind: "once", date: form.date, time } : undefined;
    case "daily":
    case "weekdays":
      return time ? { kind: form.kind, time } : undefined;
    case "weekly":
      if (!form.days.length) errors.days = "Pick at least one day.";
      return time && form.days.length
        ? { kind: "weekly", days: [...form.days].sort((a, b) => a - b), time }
        : undefined;
    case "hours": {
      const every = Number(form.every);
      return time
        ? ({
            kind: "hours",
            every,
            ...(time !== "00:00" ? { from: time } : {}),
          } as RoutineWhen)
        : undefined;
    }
    case "custom":
      if (!form.rule.trim())
        errors.rule = "Write the rule, for example FREQ=WEEKLY;BYDAY=MO;BYHOUR=9.";
      return { kind: "custom", rule: form.rule.trim() };
  }
}

// A one-off whose time has passed would never run. `saved` is the schedule as it is now, which an
// edit that leaves it alone may keep.
export interface FormClock {
  tz: string;
  now: number;
  saved?: RoutineWhen;
}

// Every problem at once, keyed by field, or the draft the daemon takes.
export function draftFromForm(
  form: RoutineFormState,
  clock?: FormClock,
): { ok: true; draft: RoutineDraft } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const name = form.name.trim();
  const instruction = form.instruction.trim();
  if (!name) errors.name = "Give the routine a name.";
  else if (name.length > 80) errors.name = "Keep the name under 80 characters.";
  else if (/[\r\n]/.test(name)) errors.name = "Keep the name on one line.";
  if (!instruction) errors.instruction = "Say what dot should do.";
  const when = whenOf(form, errors);
  if (
    clock &&
    when?.kind === "once" &&
    JSON.stringify(when) !== JSON.stringify(clock.saved) &&
    `${when.date}T${when.time}` <= localMinute(clock.tz, clock.now)
  )
    errors.time = "That time has passed. Pick a later one.";
  if (form.ends && !/^\d{4}-\d{2}-\d{2}$/.test(form.until)) errors.until = "Pick the last day.";
  const budget = Number(form.budget);
  if (form.limited && !(form.budget && Number.isFinite(budget) && budget >= 0.01 && budget <= 100))
    errors.budget = "Set an amount from $0.01 to $100.";
  if (Object.keys(errors).length || !when) return { ok: false, errors };
  const draft = {
    name,
    instruction,
    when,
    ...(form.ends ? { until: form.until } : {}),
    profile: form.profile,
    notify: form.notify,
    missedPolicy: form.missedPolicy,
    approvalWindowMinutes: Number(form.windowMinutes),
    budgetUSD: form.limited ? Math.round(budget * 100) / 100 : null,
  };
  const parsed = RoutineDraft.safeParse(draft);
  if (!parsed.success) return { ok: false, errors: { name: "This routine isn't complete yet." } };
  return { ok: true, draft: parsed.data };
}
