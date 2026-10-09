import type {
  MissedPolicy,
  Routine,
  RoutineNotify,
  RoutineOutcome,
  RoutineProfile,
  RoutineRun,
  SessionOrigin,
} from "@localdot/protocol";
import type { GlyphState } from "../ui/StatusGlyph.tsx";

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
  new Intl.DateTimeFormat("en-GB", {
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
  if (dayIn(ms, tz) === dayIn(now, tz)) return `Today ${at}`;
  if (dayIn(ms, tz) === dayIn(now + 86_400_000, tz)) return `Tomorrow ${at}`;
  if (dayIn(ms, tz) === dayIn(now - 86_400_000, tz)) return `Yesterday ${at}`;
  return `${dateIn(ms, tz)} ${at}`;
}

// A list's shorter form: the weekday within a week, the date after that.
export function shortWhen(ms: number, tz: string, now: number): string {
  const days =
    (Date.parse(`${dayIn(ms, tz)}T00:00:00Z`) - Date.parse(`${dayIn(now, tz)}T00:00:00Z`)) /
    86_400_000;
  if (days < 0 || days > 1) {
    const at = timeIn(ms, tz);
    const date = new Intl.DateTimeFormat("en-GB", {
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
    return "needs you now";
  if (routine.lastRun?.outcome === "running" || routine.lastRun?.outcome === "pending")
    return "running now";
  if (routine.state === "paused") return "Paused";
  if (routine.state === "finished") return "Finished";
  if (!routine.nextDueAt) return "Planning…";
  return `next ${shortWhen(Date.parse(routine.nextDueAt), routine.tz, now)}`;
}

export function nextRunText(routine: Routine, now: number): string {
  if (routine.state === "proposed") return "Not saved yet";
  if (routine.state === "paused") return "Paused";
  if (routine.state === "finished") return "Finished";
  if (!routine.nextDueAt) return "Planning…";
  return `Next ${whenText(Date.parse(routine.nextDueAt), routine.tz, now)}`;
}

export const OUTCOME_WORDS: Record<RoutineOutcome, string> = {
  pending: "Starting",
  running: "Running",
  done: "Done",
  needs_you: "Needs you",
  needs_you_expired: "Nobody answered",
  failed: "Failed",
  skipped: "Skipped",
  missed: "Missed",
  budget: "Spending limit reached",
  stopped: "Stopped",
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
    return `Missed ${due} · ran at ${timeIn(Date.parse(run.startedAt), tz)}`;
  if (run.note === "Run now") return "Run now";
  switch (run.outcome) {
    case "missed":
      return run.note || `Missed ${due}`;
    case "needs_you_expired":
      return run.note ? `Nobody answered · ${run.note}` : "Nobody answered in time";
    case "skipped":
      return run.note === "computer busy"
        ? "Skipped · your computer was busy"
        : run.note || "Skipped";
    case "needs_you":
      return run.note || "Waiting for you";
    case "pending":
      return "Starting";
    case "running":
      return "Running now";
    default:
      return run.note || OUTCOME_WORDS[run.outcome];
  }
}

export const AWAY: Record<RoutineProfile, { label: string; description: string }> = {
  ask_first: {
    label: "Ask me first",
    description: "Anything consequential waits for your OK.",
  },
  read_only: {
    label: "Only look and read",
    description: "Never types, clicks, runs commands or changes files.",
  },
  act_within_rules: {
    label: "Use my usual rules",
    description: "Works the way your Autonomy settings say.",
  },
};

export const NOTIFY: Record<RoutineNotify, string> = {
  changes: "When something changes",
  always: "After every run",
  needs_me: "Only if it needs me",
};

export const MISSED: Record<MissedPolicy, string> = {
  run_once: "Run once when I'm back",
  skip: "Skip it",
};

// Without a limit of its own, a run follows the user's usual spending settings.
export function budgetText(usd: number | null): string {
  return usd === null ? "Your usual limit" : `$${usd.toFixed(2)}`;
}

export function waitText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} hour${hours === 1 ? "" : "s"}` : `${minutes} min`;
}

// What a thread a routine started says above its first message.
export function originLine(origin: SessionOrigin, tz?: string): string {
  const at = timeIn(
    Date.parse(origin.dueAt),
    tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  return origin.kind === "routine"
    ? `${origin.name} · started by a routine at ${at}`
    : `A follow-up dot scheduled · ${at}`;
}
