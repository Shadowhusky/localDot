import { type EventOf, PlanProvider, type PlanUsage, ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { PrivateFiles } from "./private-files.ts";

const FILE = "auto-continue.json";
const MAX_BYTES = 64 * 1024;
const MAX_WAITING = 64;
// A little after the plan's own reset time, so its count has turned over everywhere.
const JITTER_MS = { min: 30_000, max: 90_000 };
// A plan that didn't say when it resets is looked at this often, for this long.
const CHECK_MS = 10 * 60_000;
const CHECK_FOR_MS = 4 * 60 * 60_000;
// A reset further off than this is no reading to wait on.
const MAX_WAIT_MS = 8 * 24 * 60 * 60_000;
// Meeting the limit again this soon after continuing counts as one more try.
const AGAIN_MS = 30 * 60_000;
export const MAX_TRIES = 5;
// The task can't be continued this moment (the user holds the computer, or it didn't start).
const BUSY_MS = 60_000;
const READ_MS = 30_000;
// setTimeout's longest wait.
const MAX_TIMER_MS = 2 ** 31 - 1;

// The pauses a plan's limit causes, and whose plan each is.
export const PLAN_LIMITS: Readonly<Record<string, PlanProvider>> = Object.freeze({
  "claude code plan limit reached": "claude-code",
  "chatgpt plan limit reached": "chatgpt",
});

type AutoContinue = NonNullable<EventOf<"agent.state">["data"]["autoContinue"]>;

const Ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Waiting = z.strictObject({
  sessionId: z.string().regex(ULID_PATTERN),
  cellId: z.string().max(64),
  provider: PlanProvider,
  reason: z.string().max(200),
  detail: z.string().max(200).optional(),
  // The conversation's model when the limit was met: another one means the user moved on.
  model: z.string().max(300).optional(),
  // The task's inbox as the limit left it: anything the user sends after moves it on.
  seq: z.number().int().nonnegative(),
  // When this run of tries began, when dot next looks, and the time after which a reading of the
  // plan is news.
  since: Ms,
  at: Ms,
  after: Ms,
  // The plan didn't say when it resets, so dot looks at its usage until it does.
  checking: z.boolean(),
  tries: z.number().int().min(1).max(100),
  // dot continued the task then; meeting the limit again soon after is another try.
  resumedAt: Ms.optional(),
});
type Waiting = z.infer<typeof Waiting>;
const Stored = z.object({ waiting: z.array(z.unknown()).max(MAX_WAITING) });

export interface WaitingTask {
  readonly id: string;
  readonly cellId: string;
  readonly inboxSequence: number;
  readonly status: string;
  readonly stopped: boolean;
  readonly controlHeld: boolean;
}

export interface AutoContinueDeps {
  home: string;
  enabled(): boolean;
  plan(provider: PlanProvider): PlanUsage | undefined;
  // Reads the plans' usage from their own apps, where they can be read without a model turn.
  refresh(): Promise<void>;
  live(sessionId: string): WaitingTask | undefined;
  // The newest task of the conversation this task is part of.
  latest(sessionId: string): string;
  model(sessionId: string): string | undefined;
  // Tells the task, live or ended, what dot will do about the limit.
  announce(
    sessionId: string,
    paused: { reason: string; detail?: string; autoContinue: AutoContinue },
  ): void;
  // Continues the paused task as the user's Continue would.
  resume(task: WaitingTask): void;
  // Carries on a task a restart ended, as the conversation's next task; its id.
  carryOn(waiting: { sessionId: string; cellId: string }): Promise<string>;
  now?(): number;
  random?(): number;
}

// When the limit that stopped a plan lifts, if the plan said and it is still to come.
export function planResets(plan: PlanUsage | undefined, now: number): number | undefined {
  if (!plan?.limitReached) return undefined;
  const reached = plan.windows.filter((window) => window.usedPercent >= 100);
  const seconds =
    plan.limitResetsAt ??
    (reached.length && reached.every((window) => window.resetsAt !== undefined)
      ? Math.max(...reached.map((window) => window.resetsAt ?? 0))
      : undefined);
  if (seconds === undefined) return undefined;
  const at = seconds * 1000;
  return at > now && at - now <= MAX_WAIT_MS ? at : undefined;
}

// Tasks a subscription plan's limit paused, each continued by itself once the plan resets: at the
// reset the plan reported, or, when it reported none, once a look at its usage finds it lifted.
// The schedule is kept on disk, so a restart carries it on; anything the user does to the task
// meanwhile, Stop, a message, Continue or another model, ends the wait.
export class AutoContinueScheduler {
  readonly #deps: AutoContinueDeps;
  readonly #files: PrivateFiles;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #waiting = new Map<string, Waiting>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ticking: Promise<void> | undefined;
  #started = false;
  #closed = false;
  constructor(deps: AutoContinueDeps) {
    this.#deps = deps;
    this.#files = new PrivateFiles(deps.home);
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? Math.random;
    for (const waiting of this.#load()) this.#waiting.set(waiting.sessionId, waiting);
  }
  // Begins the clock once the tasks it continues can run.
  start(): void {
    if (this.#closed) return;
    this.#started = true;
    this.#arm();
  }
  // Sessions waiting, and when each continues or is next looked at.
  list(): Waiting[] {
    return [...this.#waiting.values()].map((waiting) => ({ ...waiting }));
  }
  // A task paused at its plan's limit. `auto`: whether this task may go on by itself at all.
  limited(task: WaitingTask, reason: string, detail?: string, auto = true): void {
    const provider = PLAN_LIMITS[reason];
    if (this.#closed || !provider) return;
    if (!auto || !this.#enabled()) {
      const held = this.#waiting.get(task.id);
      if (held) this.#drop(held);
      try {
        this.#deps.announce(task.id, {
          reason,
          ...(detail ? { detail: detail.slice(0, 200) } : {}),
          autoContinue: { off: "disabled" },
        });
      } catch {
        console.error(`task ${task.id}: its plan-limit pause could not be shown`);
      }
      return;
    }
    const now = this.#now();
    const before = this.#waiting.get(task.id);
    const again = before?.resumedAt !== undefined && now - before.resumedAt < AGAIN_MS;
    const tries = before
      ? before.resumedAt === undefined
        ? before.tries
        : again
          ? before.tries + 1
          : 1
      : 1;
    const model = this.#deps.model(task.id);
    const waiting: Waiting = {
      sessionId: task.id,
      cellId: task.cellId,
      provider,
      reason,
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
      ...(model ? { model } : {}),
      seq: task.inboxSequence,
      since: tries > 1 && before ? before.since : now,
      at: now,
      after: now,
      checking: true,
      tries,
    };
    if (tries > MAX_TRIES) {
      this.#giveUp(waiting);
      return;
    }
    if (!before && this.#waiting.size >= MAX_WAITING) return;
    this.#schedule(waiting, now);
    this.#put(waiting);
    // The plan may say when it resets once it is read; until then dot looks every few minutes.
    if (waiting.checking) void this.#learn(waiting);
  }
  // Something happened in a task: the user's message, Stop or Continue ends its wait.
  observe(sessionId: string, event: { type: string; data?: unknown }): void {
    const waiting = this.#waiting.get(sessionId);
    if (!waiting || this.#closed) return;
    // The user's message moves the task on from its card, so dot goes on with it now.
    if (event.type === "message.user" || event.type === "session.end") this.#drop(waiting);
    else if (event.type === "agent.state" && waiting.resumedAt === undefined) {
      const state = event.data as { state?: string; reason?: string };
      if (state.state !== "paused" || state.reason !== waiting.reason) this.#drop(waiting);
    }
  }
  // The user's "Don't continue".
  cancel(sessionId: string): boolean {
    const waiting = this.#waiting.get(sessionId);
    if (!waiting || waiting.resumedAt !== undefined) return false;
    this.#drop(waiting);
    this.#off(waiting, "cancelled");
    return true;
  }
  // Auto-continue was turned off: nothing waits on it any more.
  cancelAll(): void {
    for (const waiting of [...this.#waiting.values()])
      if (waiting.resumedAt === undefined) this.cancel(waiting.sessionId);
      else this.#drop(waiting);
  }
  // A shutdown keeps the schedule on disk for the next start; the tasks it ends still wait.
  close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.#ticking ?? Promise.resolve();
  }

  #enabled(): boolean {
    try {
      return this.#deps.enabled();
    } catch {
      return false;
    }
  }
  #jitter(): number {
    return Math.round(JITTER_MS.min + this.#random() * (JITTER_MS.max - JITTER_MS.min));
  }
  // When to look next: just after the reset the plan reported, or in a few minutes.
  #schedule(waiting: Waiting, now: number): void {
    const resets = planResets(this.#deps.plan(waiting.provider), now);
    if (resets !== undefined) {
      waiting.at = resets + this.#jitter();
      waiting.after = resets;
      waiting.checking = false;
    } else {
      waiting.at = now + CHECK_MS;
      waiting.after = now;
      waiting.checking = true;
    }
  }
  async #learn(waiting: Waiting): Promise<void> {
    await this.#read();
    if (this.#closed || this.#waiting.get(waiting.sessionId) !== waiting || !waiting.checking)
      return;
    const now = this.#now();
    if (planResets(this.#deps.plan(waiting.provider), now) === undefined) return;
    this.#schedule(waiting, now);
    this.#put(waiting);
  }
  async #read(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#deps.refresh().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, READ_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  #put(waiting: Waiting): void {
    this.#waiting.set(waiting.sessionId, waiting);
    this.#save();
    this.#announce(waiting);
    this.#arm();
  }
  #drop(waiting: Waiting): void {
    if (this.#waiting.get(waiting.sessionId) !== waiting) return;
    this.#waiting.delete(waiting.sessionId);
    this.#save();
    this.#arm();
  }
  #announce(waiting: Waiting): void {
    this.#tell(waiting, { at: waiting.at, ...(waiting.checking ? { checking: true } : {}) });
  }
  #off(waiting: Waiting, why: "cancelled" | "gave_up" | "disabled"): void {
    this.#tell(waiting, { off: why });
  }
  #tell(waiting: Waiting, autoContinue: AutoContinue): void {
    try {
      this.#deps.announce(waiting.sessionId, {
        reason: waiting.reason,
        ...(waiting.detail ? { detail: waiting.detail } : {}),
        autoContinue,
      });
    } catch {
      console.error(`task ${waiting.sessionId}: its plan-limit wait could not be shown`);
    }
  }
  #giveUp(waiting: Waiting): void {
    const held = this.#waiting.get(waiting.sessionId);
    if (held) this.#drop(held);
    console.warn(`task ${waiting.sessionId} still meets its plan's limit; not continuing it again`);
    this.#off(waiting, "gave_up");
  }
  #arm(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#started || this.#closed || this.#ticking) return;
    const due = [...this.#waiting.values()]
      .filter((waiting) => waiting.resumedAt === undefined)
      .map((waiting) => waiting.at);
    if (!due.length) return;
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, Math.min(...due) - this.#now()));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#ticking = Promise.resolve()
        .then(() => this.#tick())
        .finally(() => {
          this.#ticking = undefined;
          this.#arm();
        });
    }, wait);
    this.#timer.unref?.();
  }
  async #tick(): Promise<void> {
    const now = this.#now();
    for (const waiting of [...this.#waiting.values()]) {
      if (this.#closed) return;
      if (waiting.resumedAt !== undefined) {
        // Long enough since dot continued it that a new limit starts afresh.
        if (now - waiting.resumedAt >= AGAIN_MS) this.#drop(waiting);
        continue;
      }
      if (waiting.at > now) continue;
      try {
        await this.#due(waiting);
      } catch {
        console.error(`task ${waiting.sessionId}: continuing after the plan's limit failed`);
      }
    }
  }
  // The task as the limit left it, "ended" when a restart ended it there, "busy" when it can't be
  // continued this moment; undefined once the user moved it on, `paused` saying whether it still
  // sits paused at the limit for all that.
  #still(waiting: Waiting): WaitingTask | "ended" | "busy" | { paused: boolean } {
    const task = this.#deps.live(waiting.sessionId);
    const paused = task
      ? !task.stopped && task.status === "paused"
      : this.#deps.latest(waiting.sessionId) === waiting.sessionId;
    if (
      this.#waiting.get(waiting.sessionId) !== waiting ||
      !paused ||
      (task && task.inboxSequence !== waiting.seq) ||
      this.#deps.model(waiting.sessionId) !== waiting.model
    )
      return { paused };
    if (!task) return "ended";
    return task.controlHeld ? "busy" : task;
  }
  // Ends a wait the user moved on from; one still showing on a paused task says it is off.
  #movedOn(waiting: Waiting, still: { paused: boolean }): void {
    const held = this.#waiting.get(waiting.sessionId) === waiting;
    this.#drop(waiting);
    if (held && still.paused) this.#off(waiting, "cancelled");
  }
  async #due(waiting: Waiting): Promise<void> {
    const before = this.#still(waiting);
    if (!this.#enabled())
      return this.#movedOn(
        waiting,
        typeof before === "object" && "paused" in before ? before : { paused: true },
      );
    if (typeof before === "object" && "paused" in before) return this.#movedOn(waiting, before);
    await this.#read();
    if (this.#closed) return;
    const task = this.#still(waiting);
    if (typeof task === "object" && "paused" in task) return this.#movedOn(waiting, task);
    const now = this.#now();
    if (task === "busy") {
      waiting.at = now + BUSY_MS;
      this.#save();
      return;
    }
    const plan = this.#deps.plan(waiting.provider);
    const resets = planResets(plan, now);
    // The plan says it is still at its limit, until a later reset or one it doesn't name.
    if (resets !== undefined || (plan?.limitReached && plan.observedAt > waiting.after)) {
      if (resets === undefined && now - waiting.since >= CHECK_FOR_MS) return this.#giveUp(waiting);
      if (resets !== undefined && ++waiting.tries > MAX_TRIES) return this.#giveUp(waiting);
      this.#schedule(waiting, now);
      this.#put(waiting);
      return;
    }
    if (task === "ended") {
      let next: string;
      try {
        next = await this.#deps.carryOn(waiting);
      } catch {
        if (++waiting.tries > MAX_TRIES) return this.#giveUp(waiting);
        waiting.at = this.#now() + BUSY_MS;
        this.#save();
        return;
      }
      this.#drop(waiting);
      if (this.#closed) return;
      const carried: Waiting = { ...waiting, sessionId: next, resumedAt: this.#now() };
      const model = this.#deps.model(next);
      if (model) carried.model = model;
      else delete carried.model;
      this.#waiting.set(next, carried);
      this.#save();
      return;
    }
    waiting.resumedAt = now;
    this.#save();
    this.#deps.resume(task);
  }
  #load(): Waiting[] {
    try {
      const text = this.#files.text(FILE, MAX_BYTES);
      if (text === undefined) return [];
      const stored = Stored.safeParse(JSON.parse(text));
      if (!stored.success) return [];
      // A task dot had continued was working when the service stopped: that is no wait.
      return stored.data.waiting.flatMap((value) => {
        const waiting = Waiting.safeParse(value);
        return waiting.success && waiting.data.resumedAt === undefined ? [waiting.data] : [];
      });
    } catch {
      return [];
    }
  }
  #save(): void {
    try {
      this.#files.write(FILE, `${JSON.stringify({ waiting: this.list() })}\n`);
    } catch {
      console.error("the plan-limit schedule could not be saved");
    }
  }
}
