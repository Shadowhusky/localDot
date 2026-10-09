import type {
  ApprovalRequestDraft,
  AskFieldRecord,
  AskFieldValue,
  AskRequestField,
  PageElement,
  PauseSnapshot,
  RecentLine,
  RuleChange,
} from "@localdot/protocol";
import {
  APPROVAL_TIMEOUT_MS,
  type ApprovalCard,
  type AutonomyPolicy,
  askValueProblem,
  type BootConfig,
  type EventDraft,
  freezeAutonomy,
  InboxItem,
  type InboxReply,
  SessionRun,
  type TranscriptAppend,
  ulid,
} from "@localdot/protocol";
import type { ScreenName, ScreenSwitchData } from "../../../../packages/protocol/src/screens.ts";
import type { ScreenController, ScreenLease, ScreenScope } from "../browser/screen-controller.ts";
import { NO_CONNECTORS as NO_TASK_CONNECTORS, type TaskConnectors } from "../connectors/hub.ts";
import type { EventLog } from "../event-log.ts";
import type { GuiAction, NativeActionIdentity } from "../gateway/gateway.ts";
import {
  type ActionBinding,
  ApprovalBroker,
  type ApprovalChecks,
  type ApprovalOutcome,
} from "./safety/approvals.ts";
import { ConnectionCards } from "./safety/connections.ts";
import type { Purpose, PurposeGate } from "./safety/purpose.ts";
import { RepeatGuard } from "./safety/repeat-guard.ts";
import { RuleError, type RulesStore } from "./safety/rules.ts";
import { PausedStepError, StepBarrier } from "./safety/step-barrier.ts";
import { TaskTaint } from "./safety/taint.ts";
import { TaskAutonomy } from "./safety/task-autonomy.ts";
import { SecretAnswers } from "./secret-answers.ts";
import type { TranscriptStore } from "./transcript.ts";

export const AGENT = "main";
// How long a hand-back waits for the user's input to land and the computer to confirm it.
const HANDBACK_WAIT_MS = 5000;
// After input whose landing was unknown, the computer is asked again this much later each time.
const CONFIRM_RETRY_MS = { first: 250, max: 5000 };
export type SessionStatus = "starting" | "running" | "waiting_user" | "paused" | "idle" | "ended";
export interface AskAnswer {
  option?: string;
  text?: string;
  // Per field id, as the journal and the model may see them: a secret only as provided.
  fields?: Readonly<Record<string, AskFieldRecord>>;
  declined?: true;
  // Never journaled: the ask tool types these into their fields and clears them.
  secrets?: SecretAnswers;
  by: "user" | "timeout" | "stop" | "pause" | "control";
}
export interface AskForm {
  question: string;
  fields: readonly AskRequestField[];
  submit?: string;
  decline?: string;
}
interface Question {
  question: string;
  options: string[];
  allowText: boolean;
  form?: Omit<AskForm, "question">;
  // Only an answer ends it: "Not now" is refused.
  declinable?: boolean;
}
export interface TakeoverOutcome {
  note?: string;
  by: "user" | "stop";
  // The user said "Not now" to dot's hand-off.
  declined?: true;
}
export interface PlanItem {
  id: string;
  text: string;
  status: "todo" | "doing" | "done" | "skipped";
}
export interface BrainGeneration {
  readonly id: number;
  readonly signal: AbortSignal;
}
export interface ToolLease {
  readonly generation: BrainGeneration;
  readonly signal: AbortSignal;
  check(): void;
  finish(): void;
}
export interface ManualLease {
  readonly requestId: string;
  readonly signal: AbortSignal;
  // Also aborts once the user hands control back: input already on its way still lands, but
  // nothing waits for more.
  readonly returning: AbortSignal;
  check(): void;
  // The user typed under this control. The takeover's end says so, never what was typed.
  typed(): void;
  // Input whose landing is unknown fences control until `confirm`, the computer's answer that
  // everything sent before it has landed, succeeds; with no way to confirm, until Stop.
  finish(uncertain?: boolean, confirm?: () => Promise<void>): void;
}
interface ActiveCall {
  abort: AbortController;
  settled: Promise<void>;
  finish(): void;
}
interface ManualCall extends ActiveCall {
  returning: AbortController;
}
interface ControlRecord {
  requestId: string;
  startedByGeneration: number;
  held: boolean;
  returning: boolean;
  manualUnconfirmed: boolean;
  confirm?: () => Promise<void>;
  confirming?: Promise<boolean>;
  settling?: boolean;
  typed: boolean;
  released: Promise<TakeoverOutcome>;
  resolve(outcome: TakeoverOutcome): void;
  step?: string;
  // The user has taken the computer: they asked for it, or took the one dot handed over.
  taken: boolean;
  // The user took the computer themselves, at this time, from a task in this state, maybe setting
  // aside dot's question.
  user?: { since: number; from: SessionStatus; asked: boolean };
}
export class SessionStoppedError extends Error {
  constructor() {
    super("the session or agent call is no longer active");
    this.name = "SessionStoppedError";
  }
}
export class ControlHeldError extends Error {
  constructor() {
    super("the user has control of the desktop");
    this.name = "ControlHeldError";
  }
}

// Resolves after `ms`, or as soon as `signal` aborts.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

// What dot hears when the user hands back control they took: never what they did or typed.
function handedBack(ms: number, asked: boolean): string {
  const s = Math.max(1, Math.round(ms / 1000));
  const took = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
  return `(The user took over the computer for ${took} and has handed it back. The screen may have changed since you last looked: take a screenshot before your next action.${asked ? " They took it instead of answering your question: ask it again if you still need the answer." : ""})`;
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new SessionStoppedError());
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export interface AgentSessionOptions {
  // An unattended run (a routine): approval cards and questions wait this long, then the step is
  // refused.
  readonly approvalTtlMs?: number;
  readonly run?: SessionRun;
}

// Daemon-owned state outlives any brain or HTTP request. In particular, retirement cancels the
// caller of a takeover but cannot hand the computer back on the user's behalf.
export class AgentSession {
  readonly #autonomy: Readonly<AutonomyPolicy>;
  readonly taskAutonomy: TaskAutonomy;
  // What private data the task has read, and the check on where it may go; the runner installs
  // the check, and a session without one keeps only the policy's own checks.
  readonly taint: TaskTaint;
  purpose: PurposeGate | undefined;
  // The user's own words for this task: the request and every message since.
  readonly requests: string[];
  readonly #approvals: ApprovalBroker;
  readonly connections: ConnectionCards;
  readonly #approvalWindowMs: number | undefined;
  readonly #run: SessionRun | undefined;
  readonly #steps = new StepBarrier(() => {
    if (this.stopped) throw new SessionStoppedError();
  });
  #safetyRevision = 0;
  #safetyResuming = false;
  readonly #repeatGuard = new RepeatGuard();
  #repeatPauseHandler: ((requestId: string) => PauseSnapshot) | undefined;
  #repeatAsk: { askId: string; requestId: string; revision: number } | undefined;
  status: SessionStatus = "starting";
  brainCellId: string | undefined;
  boot: BootConfig | undefined;
  toolToken: string | undefined;
  lastFrameId: string | undefined;
  // Something other than the user reached the model since the user last spoke.
  #tainted = false;
  // Something other than the user has reached the model in this task: what dot plans after that
  // may follow a page's instructions, so the purpose check keeps the plan from before.
  #heardOthers = false;
  // The elements the last browser_read listed, by ref, with the screen, tab and page it read.
  pageRefs:
    | { cellId: string; tabId?: string; url: string; elements: ReadonlyMap<string, PageElement> }
    | undefined;
  // What was said earlier in the conversation this task continues.
  earlier: readonly string[] = [];
  // The user's last few tasks when this one started.
  recent: readonly RecentLine[] = [];
  // The connected apps' tools this task's model was shown.
  connectors: TaskConnectors = NO_TASK_CONNECTORS;
  toolCalls = 0;
  // The user's optional hard stop: the most tool calls between two of their messages.
  actionLimit: number | undefined;
  actionsSinceUser = 0;
  actionLimitReached = false;
  #plan: PlanItem[] = [];
  #trustedPlan: readonly string[] = [];
  readonly abort = new AbortController();
  readonly #inbox: InboxItem[] = [];
  // Notes to dot that are not the user's words: they never wake a task waiting for them.
  readonly #notes = new Set<number>();
  // dot's next input waits for a fresh look at the screen, which the user has had.
  #lookFirst = false;
  readonly #waiters = new Set<() => void>();
  readonly #active = new Map<ToolLease, ActiveCall>();
  readonly #manual = new Map<ManualLease, ManualCall>();
  // Input the agent keeps down between tool calls (a mouse button): how to let go of it.
  readonly #held = new Set<() => Promise<void>>();
  #releasing: Promise<void> | undefined;
  readonly #controlObservers = new Set<{
    generation: BrainGeneration;
    notify(): void;
  }>();
  readonly #fetched = new Map<number, InboxItem>();
  #seq = 0;
  #generationId = 0;
  #brain: { generation: BrainGeneration; abort: AbortController } | undefined;
  #delivered = 0;
  #ask:
    | {
        askId: string;
        options: string[];
        allowText: boolean;
        fields?: readonly AskRequestField[];
        declinable: boolean;
        finish(a: AskAnswer): boolean;
      }
    | undefined;
  #control: ControlRecord | undefined;
  #screens: ScreenController | undefined;
  #screenReady: BrainGeneration | undefined;
  #screenPreparing: { generation: BrainGeneration; promise: Promise<void> } | undefined;
  #screenRetiring: Promise<void> = Promise.resolve();
  #screenClosing: Promise<void> | undefined;
  #stopping = false;
  #finishing = false;
  #finishInterrupted = false;

  constructor(
    readonly id: string,
    readonly cellId: string,
    readonly task: string,
    private readonly eventLog: Pick<EventLog, "append">,
    autonomy?: AutonomyPolicy,
    rules?: Pick<RulesStore, "matches" | "add"> & Partial<Pick<RulesStore, "trusts">>,
    options: AgentSessionOptions = {},
  ) {
    const ttl = options.approvalTtlMs;
    if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 14_400_000))
      throw new RangeError("approval window must be between one minute and four hours");
    this.#approvalWindowMs = ttl;
    this.#run = options.run === undefined ? undefined : SessionRun.parse(options.run);
    this.#autonomy = freezeAutonomy(autonomy);
    this.taskAutonomy = new TaskAutonomy(rules);
    this.taint = new TaskTaint((source) => this.append("safety.taint", source));
    this.requests = [task];
    this.#approvals = new ApprovalBroker(
      Date.now,
      (card) => {
        this.setStatus("waiting_user");
        const kind =
          card.actionClass === "download_execute"
            ? "install"
            : card.actionClass === "system_settings"
              ? "permission"
              : card.actionClass === "upload"
                ? "send"
                : ["purchase", "send", "post", "delete"].includes(card.actionClass)
                  ? card.actionClass
                  : "other";
        const { fields, ...data } = card;
        this.append("approval.request", { ...data, kind, preview: { fields } });
        this.#publishState(this.safetyPause ? "paused" : "waiting_user", "approval");
      },
      ({ always, destinations, ...resolution }) => {
        if (this.status === "waiting_user" && !this.stopped && !this.controlHeld)
          this.setStatus("running");
        let change: RuleChange | undefined;
        let note = resolution.note;
        try {
          // Yes for this task on a purpose ask reaches only the hosts it named, never a kind of step.
          if (destinations) {
            if (always?.option.scope === "task") this.purpose?.allow(destinations);
          } else
            change =
              always &&
              this.taskAutonomy.grant(always.actionClass, always.option, resolution.approvalId);
        } catch (error) {
          note = `Approved once. Your Always allow choice was not saved. ${error instanceof RuleError ? error.message : "Try again later."}`;
        }
        this.append("approval.resolve", { ...resolution, ...(note ? { note } : {}) });
        if (change) this.append("rule.created", change);
      },
      ttl ?? APPROVAL_TIMEOUT_MS,
    );
    this.connections = new ConnectionCards(
      task,
      ({ fields, ...card }) => {
        this.append("approval.request", { ...card, kind: "permission", preview: { fields } });
      },
      ({ always, ...resolution }) => {
        let change: RuleChange | undefined;
        let note = resolution.note;
        try {
          change =
            always &&
            this.taskAutonomy.grant(always.actionClass, always.option, resolution.approvalId);
        } catch (error) {
          note = `Allowed once. Your Always allow choice was not saved. ${error instanceof RuleError ? error.message : "Try again later."}`;
        }
        this.append("approval.resolve", { ...resolution, ...(note ? { note } : {}) });
        if (change) this.append("rule.created", change);
      },
    );
  }
  get unattended(): boolean {
    return this.#approvalWindowMs !== undefined;
  }
  get approvalWindowMs(): number | undefined {
    return this.#approvalWindowMs;
  }
  get run(): SessionRun | undefined {
    return this.#run;
  }
  get autonomy(): Readonly<AutonomyPolicy> {
    return this.#autonomy;
  }
  get tainted(): boolean {
    return this.#tainted;
  }
  set tainted(value: boolean) {
    this.#tainted = value;
    if (value) this.#heardOthers = true;
  }
  get plan(): PlanItem[] {
    return this.#plan;
  }
  set plan(items: PlanItem[]) {
    this.#plan = items;
    // The earlier conversation holds dot's own replies, which may repeat what a page said.
    if (!this.#heardOthers && !this.earlier.length)
      this.#trustedPlan = items.map((item) => item.text);
  }
  get currentPurpose(): Purpose {
    return { request: [...this.requests], plan: [...this.#trustedPlan] };
  }
  // What a screen where the user is signed in shows is private; any other screen's is not.
  taintScreen(screen: ScreenName, host?: string, text?: string): void {
    if (this.taskAutonomy.signedIn(screen))
      this.taint.add("screen", host ?? `${screen} screen`, text);
  }
  get pendingApproval(): ApprovalCard | undefined {
    return this.#approvals.pending(this.id);
  }
  approvalField(approvalId: string, field: number): string | undefined {
    return this.#approvals.field(this.id, approvalId, field);
  }
  requestApproval(
    binding: ActionBinding,
    draft: ApprovalRequestDraft,
    checks: ApprovalChecks,
  ): Promise<ApprovalOutcome> {
    const generation = this.generation;
    if (
      !generation ||
      binding.sessionId !== this.id ||
      binding.cellId !== this.cellId ||
      binding.generation !== generation.id
    )
      return Promise.reject(new SessionStoppedError());
    const check = (value: ActionBinding) => {
      this.check(generation, checks.signal);
      if (
        value.sessionId !== this.id ||
        value.cellId !== this.cellId ||
        value.generation !== generation.id
      )
        throw new SessionStoppedError();
      checks.check(value);
    };
    return this.#approvals.request(binding, draft, { ...checks, check });
  }
  answerApproval(value: unknown): boolean {
    const generation = this.generation;
    if (
      !generation ||
      !this.isCurrent(generation) ||
      this.controlHeld ||
      this.pendingApproval?.generation !== generation.id
    )
      return false;
    return this.#approvals.answer(this.id, value);
  }
  get stopped(): boolean {
    return this.#stopping || this.abort.signal.aborted;
  }
  get delivered(): number {
    return this.#delivered;
  }
  get inboxSequence(): number {
    return this.#seq;
  }
  get generation(): BrainGeneration | undefined {
    return this.#brain?.generation;
  }
  get safetyPause(): PauseSnapshot | undefined {
    const pause = this.#steps.pause;
    return pause
      ? {
          ...pause,
          ...(this.#safetyResuming ? { phase: "resuming" as const } : {}),
          atStepBoundary: this.#steps.active === 0,
          resumeAvailable:
            !this.#safetyResuming &&
            pause.phase === "paused" &&
            this.#steps.active === 0 &&
            !this.stopped &&
            !this.controlHeld,
        }
      : undefined;
  }
  get safetyControlRevision(): number {
    return this.#safetyRevision;
  }
  runAtomic<T>(
    generation: BrainGeneration,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const combined = AbortSignal.any([
      this.abort.signal,
      generation.signal,
      ...(signal ? [signal] : []),
    ]);
    this.check(generation, combined);
    return this.#steps.run(() => {
      this.check(generation, combined);
      return work();
    }, combined);
  }
  requestSafetyPause(
    requestId: string,
    reason: "user" | "repeated_action" = "user",
  ): PauseSnapshot {
    if (this.stopped) throw new SessionStoppedError();
    if (this.controlHeld) throw new ControlHeldError();
    const prior = this.#steps.pause;
    const pausedBefore = this.status === "paused";
    this.#steps.requestPause(requestId, reason);
    void this.releaseInput();
    this.#approvals.cancel(this.id);
    this.#ask?.finish({ by: "pause" });
    this.setStatus("paused");
    if (!prior) {
      this.#safetyChanged();
      // A task already paused for a recovery keeps that reason as its published state.
      if (!pausedBefore) this.#publishState("paused", reason);
    }
    const pause = this.safetyPause;
    if (!pause) throw new PausedStepError();
    return pause;
  }
  installRepeatPauseHandler(handler: (requestId: string) => PauseSnapshot): void {
    if (this.#repeatPauseHandler) throw new Error("task safety controller already installed");
    this.#repeatPauseHandler = handler;
  }
  // A button the agent left down is let go of (and a cursor it placed is forgotten) before the user
  // gets the screen, and when the task stops, ends, pauses, switches screens or replaces its brain;
  // settlement waits for that. One pressed as any of those began is let go of at once.
  holdInput(release: () => Promise<void>): () => void {
    this.#held.add(release);
    if (this.stopped || !this.#brain || this.#control || this.safetyPause) void this.releaseInput();
    return () => {
      this.#held.delete(release);
    };
  }
  releaseInput(): Promise<void> | undefined {
    if (!this.#held.size) return undefined;
    const releases = [...this.#held];
    this.#held.clear();
    const done = Promise.allSettled(releases.map((release) => release())).then(() => {});
    const releasing = Promise.all([this.#releasing, done]).then(() => {
      if (this.#releasing === releasing) this.#releasing = undefined;
    });
    this.#releasing = releasing;
    return done;
  }
  settleNativeEffect(action: GuiAction, identity: NativeActionIdentity, changed: boolean): void {
    this.#repeatGuard.settle(action, identity, changed);
  }
  admitNativeEffect(action: GuiAction, identity: NativeActionIdentity, call: string): boolean {
    if (this.stopped || this.controlHeld || this.safetyPause) return false;
    if (this.#repeatGuard.admit(action, identity, call)) return true;
    const requestId = ulid();
    let pause: PauseSnapshot;
    if (this.#repeatPauseHandler) pause = this.#repeatPauseHandler(requestId);
    else {
      // An unwired caller cannot advertise a confirmed Resume boundary.
      pause = this.requestSafetyPause(requestId, "repeated_action");
      this.uncertainSafetyPause(pause.requestId, pause.revision);
    }
    const question = this.#question(
      {
        question:
          "I repeated the same action twice. What should I change before continuing? Resume is a separate control.",
        options: ["I will change the instructions", "I want to take control"],
        allowText: true,
        declinable: false,
      },
      0,
      undefined,
      this.abort.signal,
      () =>
        this.safetyPause?.requestId === pause.requestId &&
        this.safetyPause?.revision === pause.revision,
      (answer) => {
        if (answer.by !== "user") return;
        const options = ["I will change the instructions", "I want to take control"];
        const selected = answer.option ? options[answer.option.charCodeAt(0) - 65] : undefined;
        const text = answer.text
          ? selected
            ? `${answer.text}\nSelected option: ${selected}`
            : answer.text
          : selected;
        if (!text) throw new Error("repeat answer has no instruction");
        // post() journals the redacted user message before publishing its durable inbox identity.
        // The private question/Pause owner is checked synchronously before this callback.
        this.post("followup", text);
      },
    );
    if (this.#ask)
      this.#repeatAsk = {
        askId: this.#ask.askId,
        requestId: pause.requestId,
        revision: pause.revision,
      };
    void question.catch(() => {
      if (!this.stopped && this.safetyPause?.requestId === pause.requestId)
        this.uncertainSafetyPause(pause.requestId, pause.revision);
    });
    return false;
  }
  async safetyBoundary(signal = this.abort.signal): Promise<void> {
    await this.#steps.waitAtBoundary(signal);
  }
  confirmSafetyPause(requestId: string, revision: number): void {
    this.#steps.confirmPaused(requestId, revision);
    this.#safetyChanged();
  }
  uncertainSafetyPause(requestId: string, revision: number): void {
    this.#safetyResuming = false;
    this.#steps.uncertain(requestId, revision);
    this.#safetyChanged();
  }
  beginSafetyResume(requestId: string, revision: number): void {
    const pause = this.safetyPause;
    if (!pause?.resumeAvailable || pause.requestId !== requestId || pause.revision !== revision)
      throw new Error("pause owner not resumable");
    this.#safetyResuming = true;
    this.#safetyChanged();
  }
  resumeSafety(requestId: string, revision: number): void {
    if (this.controlHeld) throw new ControlHeldError();
    this.#steps.resume(requestId, revision);
    this.#repeatGuard.reset();
    if (this.#repeatAsk?.requestId === requestId && this.#repeatAsk.revision === revision) {
      if (this.#ask?.askId === this.#repeatAsk.askId) this.#ask.finish({ by: "pause" });
      this.#repeatAsk = undefined;
    }
    this.#safetyResuming = false;
    this.#safetyChanged();
    this.setStatus("running");
  }
  async waitForSafety(signal = this.abort.signal): Promise<void> {
    while (this.safetyPause && !this.stopped) await this.#changed(25000, signal);
    signal.throwIfAborted();
    if (this.stopped) throw new SessionStoppedError();
  }
  async waitSafetyControl(after: number, waitMs: number, signal: AbortSignal): Promise<void> {
    if (after < this.#safetyRevision) return;
    await this.#changed(Math.min(Math.max(waitMs, 0), 25000), signal);
    signal.throwIfAborted();
  }
  #safetyChanged(): void {
    this.#safetyRevision++;
    this.#wake();
    // Publication cannot interrupt private admission transitions or exact-owner containment.
    // GET/control reads retain the authoritative snapshot even if a journal append fails.
    try {
      this.append("safety.pause", {
        revision: this.#safetyRevision,
        ...(this.safetyPause ? { pause: this.safetyPause } : {}),
      });
    } catch {
      /* The private revision and wakeup have already committed. */
    }
  }
  // Viewers read the task's state from the journal; a failed append cannot undo the transition.
  #publishState(state: "paused" | "waiting_user", reason: string): void {
    try {
      this.append("agent.state", { state, reason });
    } catch {
      /* The private state has already changed. */
    }
  }
  get pendingAsk(): string | undefined {
    return this.#ask?.askId;
  }
  get pendingTakeover(): string | undefined {
    return this.#control?.requestId;
  }
  get controlHeld(): boolean {
    return this.#control !== undefined;
  }
  get manualControl(): "waiting" | "ready" | "busy" | "returning" | "unconfirmed" | undefined {
    const record = this.#control;
    return !record
      ? undefined
      : record.manualUnconfirmed
        ? "unconfirmed"
        : record.returning
          ? "returning"
          : !record.held
            ? "waiting"
            : this.#manual.size
              ? "busy"
              : "ready";
  }

  attachScreens(screens: ScreenController): void {
    if (this.#screens || this.#brain || this.#control || this.stopped)
      throw new SessionStoppedError();
    this.#screens = screens;
  }
  get screens(): ScreenController | undefined {
    return this.#screens;
  }
  #screenScope(
    generation: BrainGeneration,
    signal: AbortSignal,
    allowControl = false,
  ): ScreenScope {
    return {
      sessionId: this.id,
      generation: generation.id,
      signal: AbortSignal.any([this.abort.signal, generation.signal, signal]),
      check: () => this.check(generation, signal, allowControl),
    };
  }
  prepareScreens(generation: BrainGeneration): Promise<void> {
    this.check(generation);
    const screens = this.#screens;
    if (!screens || this.#screenReady === generation) return Promise.resolve();
    if (this.#screenPreparing?.generation === generation) return this.#screenPreparing.promise;
    const promise = (async () => {
      await this.#screenRetiring;
      this.check(generation);
      await screens.activate(this.#screenScope(generation, generation.signal));
      this.check(generation);
      this.lastFrameId = undefined;
      this.#screenReady = generation;
    })().catch(() => {
      // Cancellation of an old generation must never stop a successfully installed replacement.
      if (this.isCurrent(generation) && !this.controlHeld) this.stop();
      throw new SessionStoppedError();
    });
    this.#screenPreparing = { generation, promise };
    void promise.catch(() => {});
    return promise;
  }
  screenLease(lease: ToolLease): ScreenLease {
    lease.check();
    if (!this.#active.has(lease) || !this.#screens || this.#screenReady !== lease.generation)
      throw new SessionStoppedError();
    return this.#screens.lease(this.#screenScope(lease.generation, lease.signal));
  }
  async switchScreen(screen: ScreenName, lease: ToolLease): Promise<ScreenSwitchData> {
    lease.check();
    if (!this.#active.has(lease) || !this.#screens || this.#screenReady !== lease.generation)
      throw new SessionStoppedError();
    const releasing = this.releaseInput();
    if (releasing) {
      await releasing;
      lease.check();
    }
    const result = await this.#screens.switchTo(
      screen,
      this.#screenScope(lease.generation, lease.signal),
    );
    lease.check();
    this.lastFrameId = undefined;
    this.pageRefs = undefined;
    return result;
  }
  async screensSettled(): Promise<void> {
    for (;;) {
      const pending = this.#screenClosing ?? this.#screenRetiring;
      await pending;
      // Stop may upgrade a normal-close receipt while its physical work drains.
      if (pending === (this.#screenClosing ?? this.#screenRetiring)) return;
    }
  }

  beginBrain(): BrainGeneration {
    if (this.stopped) throw new SessionStoppedError();
    if (this.#control) throw new ControlHeldError();
    if (this.#brain) this.retireBrain(this.#brain.generation);
    const abort = new AbortController();
    const generation = Object.freeze({ id: ++this.#generationId, signal: abort.signal });
    this.#brain = { generation, abort };
    this.#fetched.clear();
    return generation;
  }
  isCurrent(generation: BrainGeneration): boolean {
    return !this.stopped && this.#brain?.generation === generation && !generation.signal.aborted;
  }
  retireBrain(generation: BrainGeneration): void {
    if (this.#brain?.generation !== generation) return;
    const previous = this.#brain;
    this.#approvals.cancel(this.id);
    this.#brain = undefined;
    this.toolToken = undefined;
    this.boot = undefined;
    this.brainCellId = undefined;
    this.#fetched.clear();
    for (const observer of this.#controlObservers)
      if (observer.generation === generation) this.#controlObservers.delete(observer);
    previous.abort.abort(new SessionStoppedError());
    void this.releaseInput();
    this.#screenReady = undefined;
    if (this.#screens && !this.stopped) {
      // takeOver fences synchronously, including physical grants that are still being prepared.
      this.#screenRetiring = this.#screens.takeOver();
      void this.#screenRetiring.catch(() => this.stop());
    }
  }
  // Drivers must close model sampling before tool cancellation can return to the model.
  // The subscription belongs to this generation; retiring it never releases held control.
  onControlRequested(generation: BrainGeneration, notify: () => void): () => void {
    this.check(generation);
    const observer = { generation, notify };
    this.#controlObservers.add(observer);
    return () => {
      this.#controlObservers.delete(observer);
    };
  }
  publishBrain(
    generation: BrainGeneration,
    values: { toolToken: string; boot: BootConfig; brainCellId: string },
  ): void {
    this.check(generation);
    this.toolToken = values.toolToken;
    this.boot = values.boot;
    this.brainCellId = values.brainCellId;
  }
  check(generation: BrainGeneration, signal?: AbortSignal, allowControl = false): void {
    if (!this.isCurrent(generation) || signal?.aborted) throw new SessionStoppedError();
    if (this.#control && !allowControl) throw new ControlHeldError();
  }
  admit(generation: BrainGeneration, requestSignal?: AbortSignal): ToolLease {
    this.check(generation, requestSignal);
    if (this.#screens && this.#screenReady !== generation) throw new SessionStoppedError();
    const abort = new AbortController();
    const signal = AbortSignal.any([
      this.abort.signal,
      generation.signal,
      abort.signal,
      ...(requestSignal ? [requestSignal] : []),
    ]);
    let resolve!: () => void;
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    let finished = false;
    const lease: ToolLease = {
      generation,
      signal,
      check: () => this.check(generation, signal),
      finish: () => {
        if (finished) return;
        finished = true;
        this.#active.delete(lease);
        resolve();
      },
    };
    this.#active.set(lease, { abort, settled, finish: lease.finish });
    return lease;
  }
  admitManual(requestId: string, requestSignal: AbortSignal): ManualLease {
    const record = this.#control;
    if (
      !record ||
      record.requestId !== requestId ||
      !record.held ||
      record.returning ||
      record.manualUnconfirmed ||
      this.stopped ||
      requestSignal.aborted ||
      this.#manual.size
    )
      throw new ControlHeldError();
    const abort = new AbortController(),
      returning = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, requestSignal, abort.signal]);
    let resolve!: () => void;
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    let finished = false;
    const lease: ManualLease = {
      requestId,
      signal,
      returning: AbortSignal.any([signal, returning.signal]),
      check: () => {
        if (
          signal.aborted ||
          this.stopped ||
          this.#control !== record ||
          !record.held ||
          record.returning ||
          record.manualUnconfirmed
        )
          throw new ControlHeldError();
      },
      typed: () => {
        record.typed = true;
      },
      finish: (uncertain = false, confirm) => {
        if (finished) return;
        finished = true;
        if (uncertain) {
          record.manualUnconfirmed = true;
          record.confirm = confirm;
        }
        this.#manual.delete(lease);
        resolve();
        if (uncertain) this.#settleManual(record);
      },
    };
    this.#manual.set(lease, { abort, returning, settled, finish: () => lease.finish() });
    return lease;
  }
  // The computer's answer that everything sent before it has landed lifts the fence that input
  // whose landing was unknown put up. dot observes the screen afresh once it has control back.
  #confirmManual(record: ControlRecord): Promise<boolean> {
    if (!record.manualUnconfirmed) return Promise.resolve(true);
    const confirm = record.confirm;
    if (!confirm || this.#control !== record || this.stopped) return Promise.resolve(false);
    if (!record.confirming) {
      const attempt = Promise.resolve()
        .then(confirm)
        .then(
          () => {
            if (this.#control !== record || this.stopped) return false;
            record.manualUnconfirmed = false;
            return true;
          },
          () => false,
        );
      record.confirming = attempt;
      void attempt.finally(() => {
        if (record.confirming === attempt) record.confirming = undefined;
      });
    }
    return record.confirming;
  }
  // A computer that cannot answer yet is asked again, a little later each time, until it confirms
  // or the user's control ends.
  #settleManual(record: ControlRecord): void {
    if (record.settling || !record.confirm) return;
    record.settling = true;
    void (async () => {
      try {
        for (
          let wait = 0;
          ;
          wait = Math.min(CONFIRM_RETRY_MS.max, wait * 2 || CONFIRM_RETRY_MS.first)
        ) {
          if (wait) await pause(wait, this.abort.signal);
          if (this.#control !== record || this.stopped || !record.manualUnconfirmed) return;
          if (await this.#confirmManual(record)) return;
        }
      } finally {
        record.settling = false;
      }
    })();
  }
  cancelManual(): void {
    for (const call of this.#manual.values()) call.abort.abort(new ControlHeldError());
  }
  // Settles once the user's control under this request ends, by hand-back or Stop, or at once
  // when it is not the current control.
  controlReleased(requestId: string): Promise<void> {
    const record = this.#control;
    return record?.requestId === requestId ? record.released.then(() => {}) : Promise.resolve();
  }
  append(type: string, data: Record<string, unknown>, step?: string): void {
    this.eventLog.append(this.id, {
      type,
      agent: AGENT,
      ...(step ? { step } : {}),
      data,
    } as unknown as EventDraft);
  }
  post(kind: InboxItem["kind"], text: string): InboxItem {
    if (this.stopped) throw new SessionStoppedError();
    const item = Object.freeze(
      InboxItem.parse({ seq: this.#seq + 1, messageId: ulid(), kind, text }),
    );
    if (kind !== "resume") this.append("message.user", { messageId: item.messageId, text, kind });
    this.#seq = item.seq;
    this.#inbox.push(item);
    if (kind !== "resume") {
      this.requests.push(text);
      this.tainted = false;
      this.actionsSinceUser = 0;
      this.actionLimitReached = false;
    }
    this.#wake();
    return { ...item };
  }
  // Reaches the model with the next fetch of the inbox, as a steer it did not hear from the user:
  // nothing journals it as the user's message.
  #note(text: string): void {
    const item = Object.freeze(
      InboxItem.parse({ seq: this.#seq + 1, messageId: ulid(), kind: "steer", text }),
    );
    this.#seq = item.seq;
    this.#inbox.push(item);
    this.#notes.add(item.seq);
    this.#wake();
  }
  // After the user hands back control they took, until dot has looked at the screen again.
  get lookOwed(): boolean {
    return this.#lookFirst;
  }
  freshLook(): void {
    this.#lookFirst = false;
  }
  async waitForUser(waitMs: number, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    const unread = () =>
      this.#inbox.some(
        (i) => i.seq > this.#delivered && i.kind !== "resume" && !this.#notes.has(i.seq),
      );
    const deadline = Date.now() + waitMs;
    while (!unread() && !this.stopped && Date.now() < deadline) {
      await this.#changed(deadline - Date.now(), combined);
      signal?.throwIfAborted();
    }
    return unread() && !this.stopped;
  }
  // A paused task may have no live brain after credential retirement. This daemon-owned wait
  // observes explicit Resume without creating a generation, fetching content or acknowledging it.
  async waitForResume(after: number, signal = this.abort.signal): Promise<void> {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.#seq)
      throw new Error("invalid resume cursor");
    const combined = AbortSignal.any([this.abort.signal, signal]);
    while (!this.#inbox.some((item) => item.seq > after && item.kind === "resume")) {
      combined.throwIfAborted();
      await this.#changed(25_000, combined);
    }
    combined.throwIfAborted();
  }
  async inbox(
    after: number,
    waitMs: number,
    signal?: AbortSignal,
    generation = this.generation,
  ): Promise<InboxReply> {
    if (!generation) throw new SessionStoppedError();
    this.check(generation, signal, true);
    if (!Number.isSafeInteger(after) || after < 0 || after > this.#seq)
      throw new Error("invalid inbox cursor");
    const ready = () => this.#inbox.filter((i) => i.seq > after);
    const combined = AbortSignal.any([
      this.abort.signal,
      generation.signal,
      ...(signal ? [signal] : []),
    ]);
    if (!ready().length && waitMs > 0) await this.#changed(Math.min(25_000, waitMs), combined);
    this.check(generation, combined, true);
    const items = ready();
    for (const item of items) this.#fetched.set(item.seq, item);
    return { items: items.map((i) => ({ ...i })), stopped: false };
  }
  // Synchronous storage commits cannot interleave a generation change. Checks between message
  // fsync and acknowledgement still protect injected storage callbacks and explicit Stop.
  appendTranscript(
    store: TranscriptStore,
    generation: BrainGeneration,
    request: TranscriptAppend,
    signal?: AbortSignal,
  ): void {
    this.check(generation, signal, true);
    const state = store.state(this.id);
    this.#delivered = Math.max(this.#delivered, state.inboxAfter);
    for (const message of request.messages) {
      if (!message.sourceInbox) continue;
      const item = this.#fetched.get(message.sourceInbox.seq);
      if (
        !item ||
        item.kind === "resume" ||
        item.messageId !== message.sourceInbox.messageId ||
        message.role !== "user" ||
        message.content !== item.text
      )
        throw new Error("transcript source does not match a fetched user message");
    }
    const after = request.inboxAfter;
    if (after !== undefined && (after < this.#delivered || after > this.#seq))
      throw new Error("invalid acknowledgement cursor");
    const records = new Map(
      state.messages.flatMap((m) => (m.sourceInbox ? [[m.sourceInbox.messageId, m] as const] : [])),
    );
    for (const message of request.messages)
      if (message.sourceInbox) records.set(message.sourceInbox.messageId, message);
    if (after !== undefined)
      for (let seq = this.#delivered + 1; seq <= after; seq++) {
        const item = this.#fetched.get(seq);
        if (!item) throw new Error("cannot acknowledge an unseen inbox item");
        const message = records.get(item.messageId);
        if (
          item.kind !== "resume" &&
          (!message || message.sourceInbox?.seq !== seq || message.content !== item.text)
        )
          throw new Error("cannot acknowledge an unrecorded user message");
      }
    store.append(this.id, request.messages);
    this.check(generation, signal, true);
    if (after !== undefined && after > this.#delivered) {
      store.acknowledge(this.id, after);
      this.check(generation, signal, true);
      this.#delivered = after;
    }
  }
  restoreDelivered(store: TranscriptStore): void {
    this.#delivered = store.state(this.id).inboxAfter;
  }

  ask(
    question: string,
    options: string[],
    allowText: boolean,
    timeoutMs: number,
    step?: string,
    generation = this.generation,
    signal?: AbortSignal,
  ): Promise<AskAnswer> {
    return this.#owned({ question, options, allowText }, timeoutMs, step, generation, signal);
  }
  // A question answered per field (HITL.md): secret answers come back apart from everything stored.
  askFields(
    { question, ...form }: AskForm,
    timeoutMs: number,
    step?: string,
    generation = this.generation,
    signal?: AbortSignal,
  ): Promise<AskAnswer> {
    return this.#owned(
      { question, options: [], allowText: false, form },
      timeoutMs,
      step,
      generation,
      signal,
    );
  }
  #owned(
    prompt: Question,
    timeoutMs: number,
    step: string | undefined,
    generation: BrainGeneration | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AskAnswer> {
    if (!generation) throw new SessionStoppedError();
    this.check(generation, signal);
    const combined = AbortSignal.any([
      this.abort.signal,
      generation.signal,
      ...(signal ? [signal] : []),
    ]);
    return this.#question(prompt, timeoutMs, step, combined, () => this.isCurrent(generation));
  }
  #question(
    { question, options, allowText, form, declinable = true }: Question,
    timeoutMs: number,
    step: string | undefined,
    combined: AbortSignal,
    ownerCurrent: () => boolean,
    beforeAnswer?: (answer: AskAnswer) => void,
  ): Promise<AskAnswer> {
    if (this.#ask) throw new Error("a question is already waiting for the user");
    combined.throwIfAborted();
    if (!ownerCurrent()) throw new SessionStoppedError();
    const askId = ulid();
    const keys = options.map((_, i) => String.fromCharCode(65 + i));
    return new Promise<AskAnswer>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const aborted = () => finish({ by: "stop" });
      const finish = (answer: AskAnswer) => {
        if (settled) return false;
        if (answer.by === "user" && (combined.aborted || this.stopped || !ownerCurrent()))
          return false;
        if (answer.declined && !declinable) return false;
        settled = true;
        if (timer) clearTimeout(timer);
        combined.removeEventListener("abort", aborted);
        if (this.#ask?.askId === askId) this.#ask = undefined;
        try {
          beforeAnswer?.(answer);
          this.append(
            "ask.answer",
            {
              askId,
              ...(answer.option ? { option: answer.option } : {}),
              ...(answer.text ? { text: answer.text } : {}),
              ...(answer.fields ? { fields: answer.fields } : {}),
              ...(answer.declined ? { declined: true } : {}),
              by: answer.by,
            },
            step,
          );
        } catch (error) {
          // Abort listeners cannot throw into the event loop or leave a tool waiting forever.
          reject(error);
          return false;
        }
        if (answer.by === "user") this.tainted = false;
        if (ownerCurrent() && !this.#control && !this.safetyPause) this.status = "running";
        resolve(answer);
        return true;
      };
      try {
        this.append(
          "ask.request",
          {
            askId,
            question,
            options: options.map((text, i) => ({ key: keys[i], text })),
            allowText,
            ...form,
            ...(declinable ? {} : { declinable: false }),
          },
          step,
        );
        this.append("agent.state", {
          state: this.safetyPause ? "paused" : "waiting_user",
          reason: "question",
        });
      } catch (error) {
        reject(error);
        return;
      }
      this.#ask = {
        askId,
        options: keys,
        allowText,
        ...(form ? { fields: form.fields } : {}),
        declinable,
        finish,
      };
      if (!this.safetyPause) this.status = "waiting_user";
      if (timeoutMs > 0) timer = setTimeout(() => finish({ by: "timeout" }), timeoutMs);
      combined.addEventListener("abort", aborted, { once: true });
      if (combined.aborted) aborted();
    });
  }
  answer(askId: string, option: string | undefined, text: string | undefined): boolean {
    const ask = this.#ask;
    if (!ask || ask.askId !== askId || ask.fields || this.stopped) return false;
    if (
      (option && !ask.options.includes(option)) ||
      (text && (!ask.allowText || text.length > 8000)) ||
      (!option && !text)
    )
      return false;
    return ask.finish({ ...(option ? { option } : {}), ...(text ? { text } : {}), by: "user" });
  }
  // Every field but a QR code needs its answer. `redact` cleans what may be stored or shown to the
  // model; secret answers are kept apart, unredacted, for typing.
  answerFields(
    askId: string,
    values: Readonly<Record<string, AskFieldValue>>,
    redact: (text: string) => string,
  ): boolean {
    const ask = this.#ask;
    const fields = ask?.fields;
    if (!ask || ask.askId !== askId || !fields || this.stopped) return false;
    if (Object.keys(values).some((id) => !fields.some((field) => field.id === id))) return false;
    const value = (id: string) => (Object.hasOwn(values, id) ? values[id] : undefined);
    if (fields.some((field) => askValueProblem(field, value(field.id)) !== undefined)) return false;
    const record: Record<string, AskFieldRecord> = {};
    const secrets: [string, string][] = [];
    for (const field of fields) {
      const answer = value(field.id);
      if (answer === undefined) continue;
      if (field.kind === "secret" && typeof answer === "string") {
        secrets.push([field.id, answer]);
        record[field.id] = { provided: true };
      } else record[field.id] = typeof answer === "string" ? redact(answer.trim()) : answer;
    }
    return ask.finish({ fields: record, secrets: new SecretAnswers(secrets), by: "user" });
  }
  // "Not now": dot is told the user declined. A question that has no way out keeps waiting.
  decline(askId: string): boolean {
    const ask = this.#ask;
    if (!ask || ask.askId !== askId || !ask.declinable || this.stopped) return false;
    return ask.finish({ declined: true, by: "user" });
  }

  // `taken`: the user chose to do this step themselves, so the computer is theirs at once.
  async takeover(
    reason: string,
    note: string,
    step?: string,
    lease?: ToolLease,
    taken = false,
  ): Promise<TakeoverOutcome> {
    const generation = lease?.generation ?? this.generation;
    if (!generation) throw new SessionStoppedError();
    this.check(generation, lease?.signal);
    // A held Pause refuses a hand-off like any step; the model can ask again after Resume.
    if (this.#steps.pause) throw new PausedStepError();
    let resolve!: (outcome: TakeoverOutcome) => void;
    const released = new Promise<TakeoverOutcome>((r) => {
      resolve = r;
    });
    const record: ControlRecord = {
      requestId: ulid(),
      startedByGeneration: generation.id,
      held: false,
      returning: false,
      manualUnconfirmed: false,
      typed: false,
      released,
      resolve,
      step,
      taken,
    };
    this.#approvals.cancel(this.id);
    this.#control = record; // Synchronous admission fence, before abort/drain or any await.
    this.#screenReady = undefined;
    const draining: Promise<void>[] = this.#screens ? [this.#screens.takeOver()] : [];
    const releasing = this.releaseInput();
    if (releasing) draining.push(releasing);
    const observers = [...this.#controlObservers].filter(
      (observer) => observer.generation === generation,
    );
    for (const observer of observers) {
      try {
        observer.notify();
      } catch {
        // Keep control fenced and notify the other owners even if one observer fails.
      }
    }
    for (const [other, call] of this.#active)
      if (other !== lease) {
        draining.push(call.settled);
        call.abort.abort(new ControlHeldError());
      }
    // This task belongs to the daemon, not to the caller's generation. A hung dependency keeps
    // the fence in place; neither a timeout nor a replacement grants premature desktop access.
    void Promise.all(draining)
      .then(() => {
        if (this.#control !== record || this.stopped) return;
        this.append(
          "takeover.request",
          { requestId: record.requestId, reason, note, ...(taken ? { by: "user" } : {}) },
          step,
        );
        record.held = true;
        this.status = "waiting_user";
        this.append("agent.state", { state: "waiting_user", reason: "takeover" });
        // The user took it while dot was still handing it over.
        if (record.taken && !taken)
          this.append("control.change", { holder: "user", reason: "handoff_request" }, step);
      })
      .catch(() => {
        /* Keep the control fence if publication fails. Stop remains available. */
      });
    const signal = AbortSignal.any([
      this.abort.signal,
      generation.signal,
      ...(lease ? [lease.signal] : []),
    ]);
    return abortable(released, signal);
  }
  // The user takes the computer at any moment, whatever dot is doing. dot's step in flight is
  // cancelled and its brain retired, so nothing of dot's reaches the computer until they hand it
  // back; the task then carries on from its saved history. A held Pause already keeps dot at a step
  // boundary, so its brain stays. Control the user already holds is theirs to keep.
  takeControl(): string {
    if (this.stopped) throw new SessionStoppedError();
    const held = this.#control;
    if (held) {
      // The user takes the computer dot handed over: from now on it is theirs, as they asked. One
      // still on its way is journaled theirs once it is held.
      if (!held.taken) {
        held.taken = true;
        if (held.held)
          this.append("control.change", { holder: "user", reason: "handoff_request" }, held.step);
      }
      return held.requestId;
    }
    const pause = this.#steps.pause;
    if ((pause && pause.phase !== "paused") || this.#safetyResuming) throw new PausedStepError();
    const generation = this.generation;
    let resolve!: (outcome: TakeoverOutcome) => void;
    const released = new Promise<TakeoverOutcome>((r) => {
      resolve = r;
    });
    const user = { since: Date.now(), from: this.status, asked: false };
    const record: ControlRecord = {
      requestId: ulid(),
      startedByGeneration: generation?.id ?? 0,
      held: false,
      returning: false,
      manualUnconfirmed: false,
      typed: false,
      released,
      resolve,
      taken: true,
      user,
    };
    this.#approvals.cancel(this.id);
    this.#control = record; // Synchronous admission fence, before abort/drain or any await.
    this.#screenReady = undefined;
    // A held Pause can't be resumed while the user has the computer; viewers read that from it.
    if (pause) this.#safetyChanged();
    const draining: Promise<void>[] = this.#screens ? [this.#screens.takeOver()] : [];
    const releasing = this.releaseInput();
    if (releasing) draining.push(releasing);
    if (generation && !pause) {
      // dot's question waits for the hand-back, when dot can ask it again.
      user.asked = this.#ask?.finish({ by: "control" }) ?? false;
      for (const observer of [...this.#controlObservers])
        if (observer.generation === generation)
          try {
            observer.notify();
          } catch {
            // The generation is retired below whatever an observer does.
          }
      if (this.isCurrent(generation)) this.retireBrain(generation);
    }
    for (const call of this.#active.values()) {
      draining.push(call.settled);
      call.abort.abort(new ControlHeldError());
    }
    void Promise.all(draining)
      .then(() => {
        if (this.#control !== record || this.stopped) return;
        this.append("takeover.request", {
          requestId: record.requestId,
          reason: "other",
          note: "",
          by: "user",
        });
        record.held = true;
        // A task at rest stays at rest; one at work waits for the user, as for dot's own hand-off.
        if (record.user?.from === "idle" || this.safetyPause) return;
        this.status = "waiting_user";
        this.append("agent.state", { state: "waiting_user", reason: "takeover" });
      })
      .catch(() => {
        /* Keep the control fence if publication fails. Stop remains available. */
      });
    return record.requestId;
  }
  endTakeover(requestId: string, note: string | undefined): boolean {
    const record = this.#control;
    if (
      this.#screens ||
      !record ||
      record.requestId !== requestId ||
      !record.held ||
      record.returning ||
      record.manualUnconfirmed ||
      this.#manual.size > 0 ||
      this.stopped ||
      (note?.length ?? 0) > 8000
    )
      return false;
    record.returning = true;
    return this.#endControl(record, note);
  }
  // `declined`: the user said "Not now" to dot's hand-off; control they took themselves has nothing
  // to decline.
  async handback(
    requestId: string,
    note: string | undefined,
    signal?: AbortSignal,
    declined = false,
  ): Promise<boolean> {
    const record = this.#control;
    if (
      !record ||
      record.requestId !== requestId ||
      !record.held ||
      record.returning ||
      this.stopped ||
      (note?.length ?? 0) > 8000 ||
      signal?.aborted
    )
      return false;
    record.returning = true; // Close admission synchronously before awaiting input.
    // Input already on its way lands first; a stream waiting with a button down lets go of it.
    const draining = [...this.#manual.values()].map((call) => {
      call.returning.abort(new ControlHeldError());
      return call.settled;
    });
    const deadline = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(HANDBACK_WAIT_MS),
      ...(signal ? [signal] : []),
    ]);
    try {
      await abortable(Promise.all(draining), deadline);
      if (!(await abortable(this.#confirmManual(record), deadline)))
        return this.#keepControl(record);
    } catch {
      return this.#keepControl(record);
    }
    if (this.#control !== record || this.stopped || this.#manual.size || record.manualUnconfirmed)
      return this.#keepControl(record);
    const generation = this.generation;
    if (this.#screens && generation) {
      try {
        await this.#screens.handback(
          this.#screenScope(generation, signal ?? generation.signal, true),
        );
        this.check(generation, signal, true);
        if (this.#control !== record || this.#manual.size || record.manualUnconfirmed) return false;
        this.#screenReady = generation;
      } catch {
        return false;
      }
    }
    // Native takeover can retire its brain. With no current generation, keep the physical
    // screens and recorder fenced until prepareScreens confirms the replacement's grant.
    if (this.#screens) this.lastFrameId = undefined;
    return this.#endControl(record, note, declined && !record.user);
  }
  // A hand-back that cannot finish leaves the user in control, free to try again.
  #keepControl(record: ControlRecord): false {
    if (this.#control === record && !this.stopped) record.returning = false;
    return false;
  }
  #endControl(record: ControlRecord, note: string | undefined, declined = false): boolean {
    // Persist the user's hand-back note before waking any replacement brain.
    if (note) this.post("steer", note);
    this.append(
      "takeover.end",
      {
        requestId: record.requestId,
        ...(note ? { note } : {}),
        by: "user",
        ...(record.typed ? { typed: true } : {}),
        ...(declined ? { declined: true } : {}),
      },
      record.step,
    );
    this.#control = undefined;
    // Whatever the user did on the computer, a page read before it is no longer one to act on.
    this.pageRefs = undefined;
    const user = record.user;
    if (!user) this.tainted = false;
    this.status = this.safetyPause ? "paused" : user?.from === "idle" ? "idle" : "running";
    if (user) {
      this.#lookFirst = true;
      this.lastFrameId = undefined;
      this.#note(handedBack(Date.now() - user.since, user.asked));
      if (this.safetyPause) this.#safetyChanged();
    }
    record.resolve({
      ...(note ? { note } : {}),
      by: "user",
      ...(declined ? { declined: true } : {}),
    });
    this.#wake();
    return true;
  }
  // Cleanup retains the live owner until calls actually settle, including after Stop. The kill
  // switch independently bounds its wait and freezes/stops the desktop if a dependency hangs.
  async toolsSettled(): Promise<void> {
    while (this.#active.size || this.#manual.size)
      await Promise.all(
        [...this.#active.values(), ...this.#manual.values()].map((call) => call.settled),
      );
    if (this.#releasing) await this.#releasing;
  }
  async waitForTools(signal?: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    while (this.#active.size) {
      await abortable(
        Promise.all([...this.#active.values()].map((call) => call.settled)),
        combined,
      );
    }
    if (this.#releasing) await abortable(this.#releasing, combined);
    combined.throwIfAborted();
  }
  async waitForControl(signal?: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    while (this.#control) await abortable(this.#control.released, combined);
    combined.throwIfAborted();
  }
  setStatus(status: SessionStatus): void {
    if (this.safetyPause && status !== "paused" && status !== "ended") return;
    if (this.stopped) {
      this.status = "ended";
      return;
    }
    if (this.#control) {
      if (this.#control.held) this.status = "waiting_user";
      return;
    }
    if (this.pendingApproval) {
      this.status = "waiting_user";
      return;
    }
    this.status = status;
  }
  async finish(): Promise<boolean> {
    // Retirement may install a final user-owned download collector. Drain it before
    // marking the session ended, so normal completion cannot invalidate its setup.
    await this.screensSettled();
    if (this.stopped) return false;
    if (
      this.#brain ||
      this.#active.size ||
      this.#manual.size ||
      this.#control ||
      this.pendingApproval ||
      this.safetyPause
    )
      throw new SessionStoppedError();
    this.#finishing = true;
    try {
      this.#end(false);
      if (!this.#finishInterrupted) this.#screenClosing = this.#screens?.finish();
      await this.screensSettled();
      return !this.#finishInterrupted;
    } catch (error) {
      this.stop();
      await this.screensSettled().catch(() => {});
      throw error;
    } finally {
      this.#finishing = false;
    }
  }
  stop(): void {
    if (this.#finishing) {
      this.#finishInterrupted = true;
      this.#screenClosing = this.#screens?.close();
      void this.#screenClosing?.catch(() => {});
      return;
    }
    this.#end(true);
  }
  #end(contain: boolean): void {
    this.#steps.stop();
    if (this.stopped) return;
    this.#stopping = true;
    this.status = "ended";
    this.#approvals.cancel(this.id);
    this.connections.cancel("The task ended, so the connection stays closed.");
    const generation = this.generation;
    if (generation) this.retireBrain(generation);
    this.abort.abort(new SessionStoppedError());
    this.#screenReady = undefined;
    if (this.#screens && contain) {
      this.#screenClosing = this.#screens.close();
      void this.#screenClosing.catch(() => {});
    }
    const record = this.#control;
    if (record) {
      try {
        if (record.held)
          this.append(
            "takeover.end",
            { requestId: record.requestId, by: "stop", ...(record.typed ? { typed: true } : {}) },
            record.step,
          );
      } catch {
        // Stop and abort callbacks must still contain the desktop if the journal cannot write.
        console.error("agent takeover end could not be recorded");
      } finally {
        this.#control = undefined;
        record.resolve({ by: "stop" });
      }
    }
    this.#wake();
  }
  #changed(waitMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, waitMs));
      this.#waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  #wake(): void {
    for (const wake of [...this.#waiters]) wake();
  }
}
