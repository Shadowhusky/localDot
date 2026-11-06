import { chmodSync } from "node:fs";
import { join } from "node:path";
import {
  describeSchedules,
  isOneOff,
  localDateOf,
  MissedPolicy,
  nextDue,
  PausedReason,
  ROUTINE_DEFAULTS,
  ROUTINE_LIMITS,
  type Routine,
  RoutineDraft,
  RoutineEdits,
  RoutineNotify,
  RoutineOutcome,
  RoutineProfile,
  type RoutineRun,
  type RoutineSchedule,
  RoutineSchedules,
  RoutineState,
  type RoutineTiming,
  RoutineUpdate,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import { z } from "zod";
import { DatabaseSync } from "../sqlite.ts";
import { migrateSchedules } from "./migrate.ts";

export class RoutineError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "RoutineError";
  }
}

export interface StoredRoutine {
  id: string;
  kind: "routine" | "follow_up";
  name: string;
  instruction: string;
  schedules: RoutineSchedule[];
  tz: string;
  start: string;
  until: string | null;
  profile: RoutineProfile;
  notify: RoutineNotify;
  approvalWindowMinutes: number;
  budgetUSD: number | null;
  missedPolicy: MissedPolicy;
  state: RoutineState;
  pausedReason: PausedReason | null;
  revision: number;
  nextDueAt: number | null;
  createdFromSession: string | null;
  followUp: { sessionId: string; note: string } | null;
  lastSeenAt: number | null;
  absenceAskedAt: number | null;
  lastResultHash: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface StoredRun {
  id: string;
  routineId: string;
  dueAt: number;
  startedAt: number | null;
  endedAt: number | null;
  sessionId: string | null;
  outcome: RoutineOutcome;
  note: string;
}
export interface CreateInit {
  state: "proposed" | "active";
  kind?: "routine" | "follow_up";
  createdFromSession?: string;
  followUp?: { sessionId: string; note: string };
}

// `anchor` is the routine's first local date, `end_at` its last.
const SCHEMA = `
PRAGMA busy_timeout=2000;
CREATE TABLE IF NOT EXISTS routines(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, instruction TEXT NOT NULL,
  schedule_json TEXT NOT NULL, tz TEXT NOT NULL, end_at TEXT, anchor TEXT NOT NULL,
  profile TEXT NOT NULL, notify TEXT NOT NULL, approval_window_s INTEGER NOT NULL,
  budget_usd REAL, missed_policy TEXT NOT NULL, state TEXT NOT NULL,
  paused_reason TEXT, revision INTEGER NOT NULL, next_due_at INTEGER,
  created_from_session TEXT, follow_up_json TEXT, last_seen_at INTEGER,
  absence_asked_at INTEGER, last_result_hash TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS routine_runs(
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, due_at INTEGER NOT NULL,
  started_at INTEGER, ended_at INTEGER, session_id TEXT, outcome TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS routine_runs_by_routine ON routine_runs(routine_id, due_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS routine_runs_open ON routine_runs(outcome);`;

const STALE = "This routine changed on another device. Reload it and try again.";
const FULL = `You already have ${ROUTINE_LIMITS.routines} routines. Delete one first.`;
const INVALID: Record<string, string> = {
  name: "A routine's name is one line of up to 80 characters.",
  instruction: "Say what the routine should do, in up to 8,000 characters.",
  start: "The start date isn't a real date.",
  until: "The end date isn't a real date.",
};
// The model and the HTTP routes both reach the store; neither gets a raw validation dump. A schedule
// says what is wrong with it in plain words.
export function validRoutine<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = String(issue?.path[0] ?? "");
  throw new RoutineError(
    400,
    field === "schedules"
      ? issue?.code === "custom"
        ? issue.message
        : "That schedule isn't valid."
      : (INVALID[field] ?? "That routine isn't valid."),
  );
}
const sameSchedules = (a: readonly RoutineSchedule[], b: readonly RoutineSchedule[]) =>
  JSON.stringify(a) === JSON.stringify(b);
export const PASSED = "That time has passed. Pick a later one.";
const NO_RUNS_LEFT = "No runs are left on those dates. Pick a later last day.";
const COLUMNS = new Set([
  "name",
  "instruction",
  "schedule_json",
  "tz",
  "anchor",
  "end_at",
  "profile",
  "notify",
  "approval_window_s",
  "budget_usd",
  "missed_policy",
  "state",
  "paused_reason",
  "next_due_at",
  "last_seen_at",
  "absence_asked_at",
  "last_result_hash",
]);
const FollowUp = z.strictObject({
  sessionId: z.string().regex(ULID_PATTERN),
  note: z.string().max(500),
});
interface Row {
  id: string;
  kind: string;
  name: string;
  instruction: string;
  schedule_json: string;
  tz: string;
  end_at: string | null;
  anchor: string;
  profile: string;
  notify: string;
  approval_window_s: number;
  budget_usd: number | null;
  missed_policy: string;
  state: string;
  paused_reason: string | null;
  revision: number;
  next_due_at: number | null;
  created_from_session: string | null;
  follow_up_json: string | null;
  last_seen_at: number | null;
  absence_asked_at: number | null;
  last_result_hash: string | null;
  created_at: number;
  updated_at: number;
}
interface RunRow {
  id: string;
  routine_id: string;
  due_at: number;
  started_at: number | null;
  ended_at: number | null;
  session_id: string | null;
  outcome: string;
  note: string;
}
type Value = string | number | null;

function fromRunRow(row: RunRow): StoredRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    dueAt: row.due_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sessionId: row.session_id,
    outcome: RoutineOutcome.parse(row.outcome),
    note: row.note,
  };
}

/** Routines and their run history in `<home>/routines.sqlite` (0600). Every SQL value is a bound
 * parameter; SET clauses are built only from the fixed COLUMNS set.
 */
export class RoutineStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #zone: () => string;

  constructor(home: string, opts: { now(): number; zone(): string }) {
    const file = join(home, "routines.sqlite");
    this.#db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.#db.exec(SCHEMA);
    migrateSchedules(this.#db);
    this.#now = opts.now;
    this.#zone = opts.zone;
    this.#prune();
  }

  // Proposals nobody saved expire, and only the newest finished routines and follow-ups are kept.
  #prune(): void {
    const { proposals, proposalDays, finished } = ROUTINE_LIMITS;
    this.#db
      .prepare(
        `DELETE FROM routines WHERE state = 'proposed' AND (created_at < ? OR id NOT IN (
          SELECT id FROM routines WHERE state = 'proposed' ORDER BY created_at DESC, id DESC LIMIT ?))`,
      )
      .run(this.#now() - proposalDays * 86_400_000, proposals);
    for (const kind of ["routine", "follow_up"])
      this.#db
        .prepare(
          `DELETE FROM routines WHERE kind = ? AND state = 'finished' AND id NOT IN (
            SELECT id FROM routines WHERE kind = ? AND state = 'finished'
            ORDER BY updated_at DESC, id DESC LIMIT ?)`,
        )
        .run(kind, kind, finished);
    this.#db.exec("DELETE FROM routine_runs WHERE routine_id NOT IN (SELECT id FROM routines)");
  }

  // A schedule with no run left would finish at once without running.
  #refuseEnded(timing: RoutineTiming): void {
    if (timing.until && timing.until < timing.start)
      throw new RoutineError(400, "The last day comes before the first.");
    if (nextDue(timing, this.#now()) === null)
      throw new RoutineError(400, isOneOff(timing) ? PASSED : NO_RUNS_LEFT);
  }

  #full(): boolean {
    return (
      this.#count(
        "SELECT COUNT(*) AS n FROM routines WHERE kind = 'routine' AND state IN ('active', 'paused')",
      ) >= ROUTINE_LIMITS.routines
    );
  }

  #fromRow(row: Row): StoredRoutine {
    return {
      id: row.id,
      kind: row.kind === "follow_up" ? "follow_up" : "routine",
      name: row.name,
      instruction: row.instruction,
      schedules: RoutineSchedules.parse(JSON.parse(row.schedule_json)),
      tz: row.tz,
      start: row.anchor,
      until: row.end_at,
      profile: RoutineProfile.parse(row.profile),
      notify: RoutineNotify.parse(row.notify),
      approvalWindowMinutes: row.approval_window_s / 60,
      budgetUSD: row.budget_usd,
      missedPolicy: MissedPolicy.parse(row.missed_policy),
      state: RoutineState.parse(row.state),
      pausedReason: row.paused_reason === null ? null : PausedReason.parse(row.paused_reason),
      revision: row.revision,
      nextDueAt: row.next_due_at,
      createdFromSession: row.created_from_session,
      followUp: row.follow_up_json === null ? null : FollowUp.parse(JSON.parse(row.follow_up_json)),
      lastSeenAt: row.last_seen_at,
      absenceAskedAt: row.absence_asked_at,
      lastResultHash: row.last_result_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #count(sql: string, ...args: (string | number)[]): number {
    return Number((this.#db.prepare(sql).get(...args) as { n: number }).n);
  }

  #require(id: string): StoredRoutine {
    const routine = this.get(id);
    if (!routine) throw new RoutineError(404, "There is no such routine.");
    return routine;
  }

  #write(id: string, fields: Record<string, Value>, bump: boolean): StoredRoutine {
    const keys = Object.keys(fields);
    for (const key of keys) if (!COLUMNS.has(key)) throw new Error(`unknown routine column ${key}`);
    const sets = [...keys.map((key) => `${key} = ?`), "updated_at = ?"];
    if (bump) sets.push("revision = revision + 1");
    this.#db
      .prepare(`UPDATE routines SET ${sets.join(", ")} WHERE id = ?`)
      .run(...keys.map((key) => fields[key] ?? null), this.#now(), id);
    return this.#require(id);
  }

  // Omit first: Partial<RoutineDraft>'s `until?: string` would intersect away RoutineUpdate's null.
  #draftFields(
    patch: Omit<Partial<RoutineDraft>, "until"> & { until?: string | null },
    current?: StoredRoutine,
  ) {
    const fields: Record<string, Value> = {};
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.instruction !== undefined) fields.instruction = patch.instruction;
    if (patch.schedules !== undefined) fields.schedule_json = JSON.stringify(patch.schedules);
    if (patch.tz !== undefined) fields.tz = patch.tz;
    if (patch.start !== undefined) fields.anchor = patch.start;
    if (patch.until !== undefined) fields.end_at = patch.until;
    if (patch.profile !== undefined) fields.profile = patch.profile;
    if (patch.notify !== undefined) fields.notify = patch.notify;
    if (patch.approvalWindowMinutes !== undefined)
      fields.approval_window_s = patch.approvalWindowMinutes * 60;
    if (patch.budgetUSD !== undefined) fields.budget_usd = patch.budgetUSD;
    if (patch.missedPolicy !== undefined) fields.missed_policy = patch.missedPolicy;
    // Only a schedule that really changed is planned again; a rename keeps a due time pending.
    if (
      (patch.schedules !== undefined &&
        !(current && sameSchedules(patch.schedules, current.schedules))) ||
      (patch.tz !== undefined && patch.tz !== current?.tz) ||
      (patch.start !== undefined && patch.start !== current?.start) ||
      (patch.until !== undefined && patch.until !== current?.until)
    )
      fields.next_due_at = null;
    return fields;
  }

  create(input: RoutineDraft, init: CreateInit): StoredRoutine {
    const draft = validRoutine(RoutineDraft, input);
    const kind = init.kind ?? "routine";
    if (kind === "routine" && init.state === "active" && this.#full())
      throw new RoutineError(409, FULL);
    if (
      init.state === "proposed" &&
      init.createdFromSession &&
      this.#count(
        "SELECT COUNT(*) AS n FROM routines WHERE state = 'proposed' AND created_from_session = ?",
        init.createdFromSession,
      ) >= ROUTINE_LIMITS.proposalsPerSession
    )
      throw new RoutineError(409, "dot already proposed three routines in this task.");
    if (
      kind === "follow_up" &&
      this.#count(
        "SELECT COUNT(*) AS n FROM routines WHERE kind = 'follow_up' AND state = 'active'",
      ) >= ROUTINE_LIMITS.followUps
    )
      throw new RoutineError(409, "Too many follow-ups are waiting.");
    const now = this.#now(),
      tz = draft.tz ?? this.#zone(),
      start = draft.start ?? localDateOf(now, tz),
      id = ulid();
    this.#refuseEnded({ schedules: draft.schedules, tz, start, until: draft.until ?? null });
    this.#db
      .prepare(
        `INSERT INTO routines(id, kind, name, instruction, schedule_json, tz, end_at, anchor, profile,
          notify, approval_window_s, budget_usd, missed_policy, state, paused_reason, revision,
          next_due_at, created_from_session, follow_up_json, last_seen_at, absence_asked_at,
          last_result_hash, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        kind,
        draft.name,
        draft.instruction,
        JSON.stringify(draft.schedules),
        tz,
        draft.until ?? null,
        start,
        draft.profile ?? ROUTINE_DEFAULTS.profile,
        draft.notify ?? ROUTINE_DEFAULTS.notify,
        (draft.approvalWindowMinutes ?? ROUTINE_DEFAULTS.approvalWindowMinutes) * 60,
        draft.budgetUSD === undefined ? ROUTINE_DEFAULTS.budgetUSD : draft.budgetUSD,
        draft.missedPolicy ?? ROUTINE_DEFAULTS.missedPolicy,
        init.state,
        init.createdFromSession ?? null,
        init.followUp ? JSON.stringify(init.followUp) : null,
        now,
        now,
        now,
      );
    this.#prune();
    return this.#require(id);
  }

  get(id: string): StoredRoutine | undefined {
    const row = this.#db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as unknown as
      | Row
      | undefined;
    return row && this.#fromRow(row);
  }

  list(opts: { includeHidden?: boolean } = {}): StoredRoutine[] {
    const rows = (opts.includeHidden
      ? this.#db.prepare("SELECT * FROM routines ORDER BY created_at, id").all()
      : this.#db
          .prepare("SELECT * FROM routines WHERE kind = 'routine' ORDER BY created_at, id")
          .all()) as unknown as Row[];
    return rows.map((row) => this.#fromRow(row));
  }

  update(id: string, input: RoutineUpdate): StoredRoutine {
    const patch = validRoutine(RoutineUpdate, input);
    const current = this.#require(id);
    if (current.revision !== patch.revision) throw new RoutineError(409, STALE);
    if (current.state === "proposed" && patch.state)
      throw new RoutineError(409, "Save the proposed routine first.");
    if (current.state === "finished" && patch.state)
      throw new RoutineError(
        409,
        "This routine has finished. Change its schedule to run it again.",
      );
    const fields = this.#draftFields(patch, current);
    if (fields.next_due_at === null) this.#refuseEnded(timingAfter(current, patch));
    if (patch.state === "paused") Object.assign(fields, { state: "paused", paused_reason: "user" });
    if (patch.state === "active")
      Object.assign(fields, {
        state: "active",
        paused_reason: null,
        next_due_at: null,
        absence_asked_at: null,
        last_seen_at: this.#now(),
      });
    // A finished routine whose schedule changes may run again.
    if (current.state === "finished" && fields.next_due_at === null && patch.state === undefined) {
      if (current.kind === "routine" && this.#full()) throw new RoutineError(409, FULL);
      Object.assign(fields, { state: "active", paused_reason: null });
    }
    return this.#write(id, fields, true);
  }

  confirm(id: string, revision: number, edits?: RoutineEdits): StoredRoutine {
    const current = this.#require(id);
    if (current.state !== "proposed") throw new RoutineError(409, "This routine is already saved.");
    if (current.revision !== revision) throw new RoutineError(409, STALE);
    if (this.#full()) throw new RoutineError(409, FULL);
    const patch = edits ? validRoutine(RoutineEdits, edits) : {};
    this.#refuseEnded(timingAfter(current, patch));
    const fields = this.#draftFields(patch, current);
    Object.assign(fields, {
      state: "active",
      paused_reason: null,
      next_due_at: null,
      last_seen_at: this.#now(),
    });
    return this.#write(id, fields, true);
  }

  setState(id: string, state: RoutineState, pausedReason: PausedReason | null): StoredRoutine {
    const routine = this.#write(
      id,
      { state, paused_reason: pausedReason, ...(state === "active" ? { next_due_at: null } : {}) },
      true,
    );
    if (state === "finished") this.#prune();
    return routine;
  }

  setNextDue(id: string, at: number | null): void {
    this.#write(id, { next_due_at: at }, false);
  }

  remove(id: string, revision: number): void {
    if (this.#require(id).revision !== revision) throw new RoutineError(409, STALE);
    this.#db.prepare("DELETE FROM routine_runs WHERE routine_id = ?").run(id);
    this.#db.prepare("DELETE FROM routines WHERE id = ?").run(id);
  }

  pauseAllActive(reason: PausedReason): string[] {
    const rows = this.#db
      .prepare(
        "UPDATE routines SET state = 'paused', paused_reason = ?, revision = revision + 1, updated_at = ? WHERE state = 'active' RETURNING id",
      )
      .all(reason, this.#now()) as { id: string }[];
    return rows.map((row) => row.id);
  }

  resumeStopAll(): string[] {
    const rows = this.#db
      .prepare(
        "UPDATE routines SET state = 'active', paused_reason = NULL, next_due_at = NULL, revision = revision + 1, updated_at = ? WHERE state = 'paused' AND paused_reason = 'stop_all' RETURNING id",
      )
      .all(this.#now()) as { id: string }[];
    return rows.map((row) => row.id);
  }

  markSeen(id: string, at: number): void {
    this.#write(id, { last_seen_at: at, absence_asked_at: null }, false);
  }

  setAbsenceAsked(id: string, at: number | null): void {
    this.#write(id, { absence_asked_at: at }, false);
  }

  setLastResultHash(id: string, hash: string): void {
    this.#write(id, { last_result_hash: hash }, false);
  }

  #run(id: string): StoredRun | undefined {
    const row = this.#db.prepare("SELECT * FROM routine_runs WHERE id = ?").get(id) as unknown as
      | RunRow
      | undefined;
    return row && fromRunRow(row);
  }

  recordRun(run: Omit<StoredRun, "id"> & { id?: string }): StoredRun {
    const id = run.id ?? ulid();
    this.#db
      .prepare(
        "INSERT INTO routine_runs(id, routine_id, due_at, started_at, ended_at, session_id, outcome, note) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        run.routineId,
        run.dueAt,
        run.startedAt,
        run.endedAt,
        run.sessionId,
        RoutineOutcome.parse(run.outcome),
        run.note.slice(0, 500),
      );
    return this.#run(id) as StoredRun;
  }

  updateRun(id: string, patch: Partial<Omit<StoredRun, "id" | "routineId" | "dueAt">>): StoredRun {
    const current = this.#run(id);
    if (!current) throw new RoutineError(404, "There is no such run.");
    const next = { ...current, ...patch };
    this.#db
      .prepare(
        "UPDATE routine_runs SET started_at = ?, ended_at = ?, session_id = ?, outcome = ?, note = ? WHERE id = ?",
      )
      .run(
        next.startedAt,
        next.endedAt,
        next.sessionId,
        RoutineOutcome.parse(next.outcome),
        next.note.slice(0, 500),
        id,
      );
    return this.#run(id) as StoredRun;
  }

  runs(routineId: string, opts: { limit?: number; before?: number } = {}): StoredRun[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = (opts.before === undefined
      ? this.#db
          .prepare(
            "SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY due_at DESC, id DESC LIMIT ?",
          )
          .all(routineId, limit)
      : this.#db
          .prepare(
            "SELECT * FROM routine_runs WHERE routine_id = ? AND due_at < ? ORDER BY due_at DESC, id DESC LIMIT ?",
          )
          .all(routineId, opts.before, limit)) as unknown as RunRow[];
    return rows.map(fromRunRow);
  }

  lastRun(routineId: string): StoredRun | undefined {
    return this.runs(routineId, { limit: 1 })[0];
  }

  // The tasks of the routine's latest runs, newest first: the next run goes on in their conversation.
  recentSessions(routineId: string): string[] {
    const rows = this.#db
      .prepare(
        "SELECT session_id FROM routine_runs WHERE routine_id = ? AND session_id IS NOT NULL ORDER BY due_at DESC, id DESC LIMIT 20",
      )
      .all(routineId) as unknown as { session_id: string }[];
    return rows.map((row) => row.session_id);
  }

  /** A run parked on Needs you is still open; the absence guard's needs_you rows are closed. */
  openRuns(): StoredRun[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM routine_runs WHERE outcome IN ('pending', 'running') OR (outcome = 'needs_you' AND ended_at IS NULL)",
        )
        .all() as unknown as RunRow[]
    ).map(fromRunRow);
  }

  close(): void {
    this.#db.close();
  }
}

export function scheduleOf(routine: StoredRoutine): RoutineTiming {
  return {
    schedules: routine.schedules,
    tz: routine.tz,
    start: routine.start,
    until: routine.until,
  };
}
function timingAfter(
  routine: StoredRoutine,
  patch: Partial<Pick<RoutineDraft, "schedules" | "tz" | "start">> & { until?: string | null },
): RoutineTiming {
  return {
    schedules: patch.schedules ?? routine.schedules,
    tz: patch.tz ?? routine.tz,
    start: patch.start ?? routine.start,
    until: patch.until === undefined ? routine.until : patch.until,
  };
}
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
export function toRun(run: StoredRun): RoutineRun {
  return {
    id: run.id,
    routineId: run.routineId,
    dueAt: new Date(run.dueAt).toISOString(),
    startedAt: iso(run.startedAt),
    endedAt: iso(run.endedAt),
    sessionId: run.sessionId,
    outcome: run.outcome,
    note: run.note,
  };
}
export function toRoutine(r: StoredRoutine, lastRun: StoredRun | undefined, now: number): Routine {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    instruction: r.instruction,
    schedules: r.schedules,
    tz: r.tz,
    start: r.start,
    until: r.until,
    profile: r.profile,
    notify: r.notify,
    approvalWindowMinutes: r.approvalWindowMinutes,
    budgetUSD: r.budgetUSD,
    missedPolicy: r.missedPolicy,
    state: r.state,
    pausedReason: r.pausedReason,
    revision: r.revision,
    nextDueAt: iso(r.nextDueAt),
    summary: describeSchedules(scheduleOf(r), now),
    createdFromSession: r.createdFromSession,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    lastRun: lastRun ? toRun(lastRun) : null,
    keepAsked: r.absenceAskedAt !== null,
  };
}
