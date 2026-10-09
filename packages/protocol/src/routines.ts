import { z } from "zod";
import { StopOutcome } from "./agent-controls.ts";
import { ULID_PATTERN } from "./ids.ts";

const Id = z.string().regex(ULID_PATTERN);
const Counter = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Instant = z.iso.datetime();
const plain = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) => value.trim().length > 0 && value.isWellFormed() && !value.includes("\0"),
      "text must be non-empty and well-formed",
    );

export const RoutineName = plain(80).refine((value) => !/[\r\n]/.test(value), "a name is one line");
export const RoutineInstruction = plain(8000);
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const LocalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, "not a calendar date");
export const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "unknown time zone");
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

// Server-side shape only; the model's `routine` tool uses a flat object (tools/routine.ts).
export const RoutineWhen = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), date: LocalDate, time: ClockTime }),
  z.strictObject({ kind: z.literal("daily"), time: ClockTime }),
  z.strictObject({ kind: z.literal("weekdays"), time: ClockTime }),
  z.strictObject({
    kind: z.literal("weekly"),
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, "days repeat"),
    time: ClockTime,
  }),
  z.strictObject({
    kind: z.literal("hours"),
    every: z.literal([...HOUR_STEPS]),
    from: ClockTime.optional(),
  }),
  z.strictObject({ kind: z.literal("custom"), rule: z.string().min(1).max(256) }),
]);
export type RoutineWhen = z.infer<typeof RoutineWhen>;

export const RoutineProfile = z.enum(["ask_first", "read_only", "act_within_rules"]);
export type RoutineProfile = z.infer<typeof RoutineProfile>;
export const RoutineNotify = z.enum(["changes", "always", "needs_me"]);
export type RoutineNotify = z.infer<typeof RoutineNotify>;
export const MissedPolicy = z.enum(["run_once", "skip"]);
export type MissedPolicy = z.infer<typeof MissedPolicy>;
export const RoutineState = z.enum(["proposed", "active", "paused", "finished"]);
export type RoutineState = z.infer<typeof RoutineState>;
export const PausedReason = z.enum(["user", "stop_all", "absence"]);
export type PausedReason = z.infer<typeof PausedReason>;
export const RoutineOutcome = z.enum([
  "pending",
  "running",
  "done",
  "needs_you",
  "needs_you_expired",
  "failed",
  "skipped",
  "missed",
  "budget",
  "stopped",
]);
export type RoutineOutcome = z.infer<typeof RoutineOutcome>;
export const WindowMinutes = z.number().int().min(5).max(240);
export const BudgetUSD = z.number().min(0.01).max(100);

// No spending limit unless the user sets one: the run then follows their usual spending settings.
export const ROUTINE_DEFAULTS = Object.freeze({
  profile: "ask_first",
  notify: "changes",
  approvalWindowMinutes: 60,
  budgetUSD: null,
  missedPolicy: "run_once",
} as const);
// Saved routines count toward `routines`; ignored proposals and finished ones are pruned to theirs,
// so a full list stays within RoutineListReply.
export const ROUTINE_LIMITS = Object.freeze({
  routines: 50,
  proposalsPerSession: 3,
  proposals: 20,
  proposalDays: 7,
  finished: 30,
  followUps: 20,
});

export const RoutineDraft = z.strictObject({
  name: RoutineName,
  instruction: RoutineInstruction,
  when: RoutineWhen,
  tz: TimeZone.optional(),
  until: LocalDate.optional(),
  profile: RoutineProfile.optional(),
  notify: RoutineNotify.optional(),
  approvalWindowMinutes: WindowMinutes.optional(),
  budgetUSD: BudgetUSD.nullable().optional(),
  missedPolicy: MissedPolicy.optional(),
});
export type RoutineDraft = z.infer<typeof RoutineDraft>;
export const RoutineUpdate = RoutineDraft.partial()
  .extend({
    revision: Counter,
    until: LocalDate.nullable().optional(),
    state: z.enum(["active", "paused"]).optional(),
  })
  .strict();
export type RoutineUpdate = z.infer<typeof RoutineUpdate>;
export const RoutineConfirm = z.strictObject({
  revision: Counter,
  edits: RoutineDraft.partial().optional(),
});
export type RoutineConfirm = z.infer<typeof RoutineConfirm>;

export const RoutineRun = z.strictObject({
  id: Id,
  routineId: Id,
  dueAt: Instant,
  startedAt: Instant.nullable(),
  endedAt: Instant.nullable(),
  sessionId: Id.nullable(),
  outcome: RoutineOutcome,
  note: z.string().max(500),
});
export type RoutineRun = z.infer<typeof RoutineRun>;

export const Routine = z.strictObject({
  id: Id,
  kind: z.enum(["routine", "follow_up"]),
  name: RoutineName,
  instruction: RoutineInstruction,
  when: RoutineWhen,
  tz: TimeZone,
  until: LocalDate.nullable(),
  profile: RoutineProfile,
  notify: RoutineNotify,
  approvalWindowMinutes: WindowMinutes,
  budgetUSD: BudgetUSD.nullable(),
  missedPolicy: MissedPolicy,
  state: RoutineState,
  pausedReason: PausedReason.nullable(),
  revision: Counter,
  nextDueAt: Instant.nullable(),
  summary: z.string().max(200),
  createdFromSession: Id.nullable(),
  createdAt: Instant,
  updatedAt: Instant,
  lastRun: RoutineRun.nullable(),
  // The absence guard asked "Keep running …?" and is waiting for an answer.
  keepAsked: z.boolean(),
});
export type Routine = z.infer<typeof Routine>;

export const RoutineRunsReply = z.strictObject({ runs: z.array(RoutineRun).max(200) });
export type RoutineRunsReply = z.infer<typeof RoutineRunsReply>;

export const StartAtLoginState = z.enum(["on", "off", "unavailable"]);
export type StartAtLoginState = z.infer<typeof StartAtLoginState>;
export const RoutineListReply = z.strictObject({
  timeZone: TimeZone,
  startAtLogin: StartAtLoginState,
  routines: z.array(Routine).max(100),
});
export type RoutineListReply = z.infer<typeof RoutineListReply>;

export const SessionOrigin = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("routine"),
    routineId: Id,
    runId: Id,
    name: RoutineName,
    dueAt: Instant,
  }),
  z.strictObject({
    kind: z.literal("follow_up"),
    routineId: Id,
    runId: Id,
    sessionId: Id,
    dueAt: Instant,
  }),
]);
export type SessionOrigin = z.infer<typeof SessionOrigin>;
export const SessionRun = z.strictObject({
  kind: z.literal("routine"),
  name: RoutineName,
  profile: RoutineProfile,
  approvalWindowMinutes: WindowMinutes,
});
export type SessionRun = z.infer<typeof SessionRun>;

export const RoutineChangedEvent = z.strictObject({
  type: z.literal("routine.changed"),
  routineId: Id,
  revision: z.number().int().nonnegative(),
  state: z.union([RoutineState, z.literal("deleted")]),
});
export const RoutineRunEvent = z.strictObject({
  type: z.literal("routine.run"),
  routineId: Id,
  runId: Id,
  outcome: RoutineOutcome,
  sessionId: Id.nullable(),
  notify: z.boolean(),
  title: z.string().max(200),
});
export const RoutineAppEvent = z.discriminatedUnion("type", [RoutineChangedEvent, RoutineRunEvent]);
export type RoutineAppEvent = z.infer<typeof RoutineAppEvent>;

export const StopAllOutcome = z.strictObject({
  sessions: z
    .array(z.strictObject({ sessionId: Id, cellId: Id, outcome: StopOutcome.nullable() }))
    .max(64),
  cells: z.array(z.strictObject({ cellId: Id, outcome: StopOutcome })).max(64),
  routinesPaused: z.number().int().nonnegative(),
  launchesCancelled: z.number().int().nonnegative(),
  confirmed: z.boolean(),
});
export type StopAllOutcome = z.infer<typeof StopAllOutcome>;
// Structural, so the daemon's KillSwitch outcome (errors: string[]) can be checked directly.
export function stopOutcomeConfirmed(
  outcome: Pick<StopOutcome, "revoked" | "paused" | "closed" | "stopped">,
): boolean {
  return (outcome.revoked && outcome.paused) || (outcome.closed && outcome.stopped);
}
