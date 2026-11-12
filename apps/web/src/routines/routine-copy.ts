import type {
  MissedPolicy,
  Routine,
  RoutineNotify,
  RoutineOutcome,
  RoutineProfile,
  RoutineRun,
  SessionOrigin,
} from "@localdot/protocol";
import { count } from "../copy/format.ts";
import { locale, t, tr } from "../i18n/index.ts";
import type { GlyphState } from "../ui/StatusGlyph.tsx";

// Dates read in the language on show; English keeps the day-month order.
const dateLocale = () => (locale() === "en" ? "en-GB" : locale());

const timeIn = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
const dayIn = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
const dateIn = (ms: number, tz: string) =>
  new Intl.DateTimeFormat(dateLocale(), {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(new Date(ms))
    .replace(",", "");

// "Today 15:00", "Tomorrow 08:30" or "Thu 15 Oct 08:30", on the routine's own clock.
export function whenText(ms: number, tz: string, now: number): string {
  const at = timeIn(ms, tz);
  if (dayIn(ms, tz) === dayIn(now, tz)) return t`Today ${at}`;
  if (dayIn(ms, tz) === dayIn(now + 86_400_000, tz)) return t`Tomorrow ${at}`;
  if (dayIn(ms, tz) === dayIn(now - 86_400_000, tz)) return t`Yesterday ${at}`;
  return `${dateIn(ms, tz)} ${at}`;
}

// A list's shorter form: the weekday within a week, the date after that.
export function shortWhen(ms: number, tz: string, now: number): string {
  const days =
    (Date.parse(`${dayIn(ms, tz)}T00:00:00Z`) - Date.parse(`${dayIn(now, tz)}T00:00:00Z`)) /
    86_400_000;
  if (days < 0 || days > 1) {
    const at = timeIn(ms, tz);
    const date = new Intl.DateTimeFormat(dateLocale(), {
      timeZone: tz,
      ...(days > 0 && days < 7 ? { weekday: "short" } : { day: "numeric", month: "short" }),
    }).format(new Date(ms));
    return `${date} ${at}`;
  }
  return whenText(ms, tz, now);
}

// What a routine's row says after its schedule.
export function rowState(routine: Routine, now: number): string {
  if (routine.lastRun?.outcome === "needs_you" && routine.lastRun.endedAt === null)
    return t`needs you now`;
  if (routine.lastRun?.outcome === "running" || routine.lastRun?.outcome === "pending")
    return t`running now`;
  if (routine.state === "paused") return t`Paused`;
  if (routine.state === "finished") return t`Finished`;
  if (!routine.nextDueAt) return t`Planning…`;
  return t`next ${shortWhen(Date.parse(routine.nextDueAt), routine.tz, now)}`;
}

export function nextRunText(routine: Routine, now: number): string {
  if (routine.state === "proposed") return t`Not saved yet`;
  if (routine.state === "paused") return t`Paused`;
  if (routine.state === "finished") return t`Finished`;
  if (!routine.nextDueAt) return t`Planning…`;
  return t`Next ${whenText(Date.parse(routine.nextDueAt), routine.tz, now)}`;
}

export const OUTCOME_WORDS: Record<RoutineOutcome, string> = {
  pending: tr("Starting"),
  running: tr("Running"),
  done: tr("Done"),
  needs_you: tr("Needs you"),
  needs_you_expired: tr("Nobody answered"),
  failed: tr("Failed"),
  skipped: tr("Skipped"),
  missed: tr("Missed"),
  budget: tr("Spending limit reached"),
  stopped: tr("Stopped"),
};

export function outcomeGlyph(outcome: RoutineOutcome): GlyphState {
  switch (outcome) {
    case "done":
      return "done";
    case "pending":
    case "running":
      return "doing";
    case "needs_you":
      return "ask";
    case "needs_you_expired":
    case "failed":
    case "budget":
      return "failed";
    default:
      return "skipped";
  }
}

// One run as its history line says it.
export function runLine(run: RoutineRun, tz: string): string {
  const due = timeIn(Date.parse(run.dueAt), tz);
  if (run.note === "late" && run.startedAt)
    return t`Missed ${due} · ran at ${timeIn(Date.parse(run.startedAt), tz)}`;
  if (run.note === "Run now") return t`Run now`;
  switch (run.outcome) {
    case "missed":
      return run.note || t`Missed ${due}`;
    case "needs_you_expired":
      return run.note ? t`Nobody answered · ${run.note}` : t`Nobody answered in time`;
    case "skipped":
      return run.note === "computer busy"
        ? t`Skipped · your computer was busy`
        : run.note || t`Skipped`;
    case "needs_you":
      return run.note || t`Waiting for you`;
    case "pending":
      return t`Starting`;
    case "running":
      return t`Running now`;
    default:
      return run.note || OUTCOME_WORDS[run.outcome];
  }
}

export const AWAY: Record<RoutineProfile, { label: string; description: string }> = {
  ask_first: {
    label: tr("Ask me first"),
    description: tr("Anything consequential waits for your OK."),
  },
  read_only: {
    label: tr("Only look and read"),
    description: tr("Never types, clicks, runs commands or changes files."),
  },
  act_within_rules: {
    label: tr("Use my usual rules"),
    description: tr("Works the way your Autonomy settings say."),
  },
};

export const NOTIFY: Record<RoutineNotify, string> = {
  changes: tr("When something changes"),
  always: tr("After every run"),
  needs_me: tr("Only if it needs me"),
};

export const MISSED: Record<MissedPolicy, string> = {
  run_once: tr("Run once when I'm back"),
  skip: tr("Skip it"),
};

// Without a limit of its own, a run follows the user's usual spending settings.
export function budgetText(usd: number | null): string {
  return usd === null ? t`Your usual limit` : `$${usd.toFixed(2)}`;
}

export function waitText(minutes: number): string {
  if (minutes < 60) return t`${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? count(hours, "hour", "hours") : t`${minutes} min`;
}

// What opens each run in a routine's conversation, and any thread a follow-up started.
export function originLine(origin: SessionOrigin, tz?: string, now = Date.now()): string {
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const due = Date.parse(origin.dueAt);
  return origin.kind === "routine"
    ? t`Routine run · ${origin.name} · ${whenText(due, zone, now)}`
    : t`A follow-up dot scheduled · ${timeIn(due, zone)}`;
}
