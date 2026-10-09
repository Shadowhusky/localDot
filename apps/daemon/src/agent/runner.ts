import { setTimeout as delay } from "node:timers/promises";
import { CHATGPT_SWITCHED_OFF } from "@localdot/codex-harness";
import {
  type AgentLimits,
  BootConfig,
  type CheckIns,
  DEFAULT_AGENT_LIMITS,
  isJevKey,
  type KeydRecord,
  type ModelBinding,
  SESSION_PAUSE_REASONS,
  type SkillSummary,
  STALL,
  type TakeComputerReply,
  type TaskModelSelection,
  type TaskPricing,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import type { Catalog } from "@localdot/providers";
import type { CellSummary } from "../cells/types.ts";
import type { EventLog } from "../event-log.ts";
import type { StopOutcome } from "../gateway/kill-switch.ts";
import type { LiveSessions } from "../gateway/live.ts";
import { type KeydClient, KeydUnavailableError } from "../keyd/client.ts";
import type { KeydHealth } from "../keyd/monitor.ts";
import {
  BindingError,
  bindingOf,
  CHATGPT,
  checkChatgptChoice,
  planOnly,
  pricingOf,
  type ResolvedRole,
  type Role,
  resolveRole,
  taskSelection,
} from "./bindings.ts";
import { type BrainCell, type BrainCells, BrainCleanupError } from "./brain-cell.ts";
import type { CodexAccount } from "./codex/account.ts";
import { CodexCleanupError, type CodexDriver } from "./codex/driver.ts";
import type { Conversations } from "./conversation.ts";
import type { MemoryStore } from "./memory.ts";
import { SafetyController } from "./safety/controller.ts";
import type { ComputerFences } from "./safety/fences.ts";
import { gatewayCompletion } from "./safety/judge-model.ts";
import { jevJudge, modelJudge } from "./safety/judges.ts";
import { judgeChoice, PurposeGate, type PurposeJudge } from "./safety/purpose.ts";
import { RulesStore } from "./safety/rules.ts";
import { SafetyIntentStore } from "./safety/store.ts";
import { taintMemory } from "./safety/taint.ts";
import { AgentSession, abortable } from "./session.ts";
import { AgentSettings } from "./settings.ts";
import { type DayLimitKeyd, syncDayLimit } from "./spending.ts";
import type { TranscriptStore } from "./transcript.ts";

export const BRAIN_DONE = 0;
export const BRAIN_GAVE_UP = 3;
const RESTART_BACKOFF_MS = [2000, 4000, 8000];
const IDLE_MS = 30 * 60 * 1000;
const TERMINAL_SNAPSHOTS = 256;
const SESSION_PAUSES = new Set<string | undefined>(SESSION_PAUSE_REASONS);
export const RAISE_BUDGET_FIRST = "Raise this task's budget before resuming it.";
// What Replay calls the user's own time on the computer.
const HOLD_TITLE = "You used the computer";
// The brain checks in only where the user asked it to.
export function agentLimits(checkIns: CheckIns | undefined): AgentLimits {
  return {
    ...DEFAULT_AGENT_LIMITS,
    ...(checkIns?.steps === undefined ? {} : { maxTurns: checkIns.steps }),
    ...(checkIns?.failures === undefined ? {} : { maxFailedCalls: checkIns.failures }),
  };
}
export interface TerminalTaskSnapshot {
  readonly sessionId: string;
  readonly cellId: string;
  readonly status: "ended";
  readonly toolCalls: number;
  readonly models?: TaskModelSelection;
}
export class AgentError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}
export interface AgentRunnerDeps {
  home: string;
  fences?: ComputerFences;
  eventLog: Pick<EventLog, "createSession" | "append" | "subscribe">;
  live: Pick<
    LiveSessions,
    "start" | "get" | "alias" | "unalias" | "settled" | "stop" | "idleOperationPending"
  >;
  cell(cellId: string): CellSummary | undefined;
  cellBusy?(cellId: string): boolean;
  installSession?(session: AgentSession, cell: CellSummary): void;
  brains: Pick<BrainCells, "open" | "start" | "exited" | "close"> &
    Partial<Pick<BrainCells, "retireSession">>;
  keyd: Pick<KeydClient, "secrets" | "beginTask" | "modelAdmission" | "setModelAdmission"> &
    DayLimitKeyd;
  keydHealth?(): KeydHealth;
  settings(): AgentSettings;
  catalog(): Catalog | undefined;
  memory: Pick<MemoryStore, "readBoth">;
  transcripts: TranscriptStore;
  conversations?: Pick<Conversations, "current" | "earlier" | "adopt"> &
    Partial<Pick<Conversations, "title">>;
  installSkills(cellId: string, signal: AbortSignal): Promise<SkillSummary[]>;
  prepareDesktop?(session: AgentSession): Promise<void>;
  waitForUploads(cellId: string, signal?: AbortSignal): Promise<void>;
  // Must invoke M3's revoke/drain/freeze/fallback path, even if session.stop() already ran.
  stopSession(sessionId: string): Promise<StopOutcome | undefined>;
  limits?: AgentLimits;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  idleMs?: number;
  // Asks Jev, through keyd, with the named key.
  jev?(secretId: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  codex?: {
    driver: Pick<CodexDriver, "run"> &
      Partial<Pick<CodexDriver, "pauseAtBoundary" | "resumeAtBoundary" | "retirementConfirmed">>;
    account: Pick<CodexAccount, "status">;
    ended?(sessionId: string): void | Promise<void>;
    authGeneration?(): number;
  };
}
// "none": the user's own hold on the computer, which no model works on.
type ModelSelection =
  | { kind: "api"; roles: readonly ResolvedRole[]; pricing: TaskPricing; initialBudget?: number }
  | { kind: "chatgpt"; model: string; denyRead: readonly string[] }
  | { kind: "none" };
interface Runtime {
  session: AgentSession;
  selection: ModelSelection;
  limits: AgentLimits;
  skills: SkillSummary[];
  epoch: number;
  brain?: BrainCell;
  brainOpening?: Promise<void>;
  initialized: boolean;
  serial: Promise<void>;
  pause?: "budget" | "keyd" | "model" | "auth";
  budgetScope?: "task" | "day";
  authResumeAfter?: number;
  authGeneration?: number;
  idleWait?: AbortController;
  containment?: Promise<void>;
  safety?: SafetyController;
  backoff?: AbortController;
  // Ended from its wait for a follow-up, because the user moved to another conversation.
  released?: boolean;
}
class CleanupUncertain extends Error {}
function uncertain(error: unknown): boolean {
  return (
    error instanceof BrainCleanupError ||
    error instanceof CodexCleanupError ||
    error instanceof CleanupUncertain ||
    (error instanceof AggregateError && error.errors.some(uncertain))
  );
}
const sleep = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal });
const budgetHold = (rt: Runtime) =>
  rt.pause === "budget" ? (rt.budgetScope ?? "task") : undefined;

// One serialized lifecycle owns each task. Generation retirement is synchronous; Docker and
// keyd settlement happen afterward, before a replacement can be admitted.
export class AgentRunner {
  readonly sessions = new Map<string, AgentSession>();
  readonly #runtime = new Map<string, Runtime>();
  // Bounded daemon-lifetime history only: never keep AgentSession, leases, brain IDs or keys.
  readonly #terminal = new Map<string, TerminalTaskSnapshot>();
  readonly #starting = new Set<string>();
  readonly #blockedCells = new Set<string>();
  readonly #wake = new Set<() => void>();
  readonly #unsubscribe: () => void;
  #health: KeydHealth;
  #lastBoot: string | undefined;
  #closing = false;
  constructor(private readonly deps: AgentRunnerDeps) {
    this.#health = deps.keydHealth?.() ?? { online: true };
    this.#lastBoot = this.#health.bootId;
    this.#unsubscribe = deps.eventLog.subscribe((id, event) => {
      const rt = this.#runtime.get(id);
      if (!rt || rt.session.stopped) return;
      if (event.type === "budget.exceeded") {
        rt.pause = "budget";
        rt.budgetScope = event.data.scope;
      }
      if (event.type !== "agent.state") return;
      if (event.data.state === "paused") {
        if (rt.selection.kind === "chatgpt" && event.data.reason === "chatgpt account changed") {
          const generation = this.deps.codex?.authGeneration?.();
          if (generation !== undefined) this.pauseForAuth(rt.session, generation);
          else {
            if (rt.pause !== "auth") rt.authResumeAfter = rt.session.inboxSequence;
            rt.pause = "auth";
            rt.idleWait?.abort();
          }
        } else if (!SESSION_PAUSES.has(event.data.reason))
          rt.pause =
            event.data.reason === "budget" ? "budget" : this.#health.online ? "model" : "keyd";
      } else if (["thinking", "acting", "observing"].includes(event.data.state)) {
        rt.pause = undefined;
        rt.budgetScope = undefined;
        if (rt.session.generation && rt.session.isCurrent(rt.session.generation))
          rt.authResumeAfter = undefined;
      }
    });
  }
  resolveRoles(keys: KeydRecord[], settings = this.deps.settings()): ResolvedRole[] {
    const snapshot = AgentSettings.parse(settings);
    if (!snapshot.main) throw new AgentError(400, "choose a main model first");
    const catalog = this.deps.catalog();
    const roles: ResolvedRole[] = [];
    for (const role of ["main", "fast", "local"] as const satisfies readonly Role[]) {
      const choice = snapshot[role];
      if (!choice) continue;
      try {
        roles.push(resolveRole(role, choice, catalog, keys));
      } catch (error) {
        if (error instanceof BindingError) throw new AgentError(400, error.message);
        throw error;
      }
    }
    return roles;
  }
  #ready(cellId: string): CellSummary {
    if (this.#closing) throw new AgentError(503, "the agent is shutting down");
    if (this.#blockedCells.has(cellId) || this.deps.fences?.isFenced(cellId))
      throw new AgentError(409, "computer cleanup needs attention before another task");
    const cell = this.deps.cell(cellId);
    if (cell?.state !== "ready") throw new AgentError(409, "the computer is not ready");
    if (
      cell.replacementPending ||
      cell.paused ||
      this.deps.cellBusy?.(cellId) ||
      this.deps.live.idleOperationPending(cellId)
    )
      throw new AgentError(409, "the computer is paused or changing state");
    return cell;
  }
  async start(cellId: string, task: string, signal?: AbortSignal): Promise<AgentSession> {
    if (!ULID_PATTERN.test(cellId) || !task.trim() || task.length > 8000)
      throw new AgentError(400, "invalid task");
    this.#ready(cellId);
    signal?.throwIfAborted();
    if (this.#starting.has(cellId)) throw new AgentError(409, "a task is already starting");
    this.#starting.add(cellId);
    try {
      // Capture at request admission, before prior-task retirement or preflight can await.
      const settings = AgentSettings.parse(this.deps.settings());
      const current = this.deps.live.get(cellId);
      if (current) {
        const old = this.sessions.get(current);
        if (old?.status !== "idle" || old.controlHeld)
          throw new AgentError(409, "a task is already running on this computer");
        // A hold the user handed back ends by itself.
        if (!this.holds(current)) old.stop();
        await (signal
          ? abortable(this.deps.live.settled(current), signal)
          : this.deps.live.settled(current));
      }
      let selection: ModelSelection;
      let keys: KeydRecord[] = [];
      if (settings.main?.provider === CHATGPT) {
        for (const role of ["main", "fast", "local"] as const) {
          const choice = settings[role];
          if (choice?.provider === CHATGPT) {
            try {
              checkChatgptChoice(role, choice);
            } catch (error) {
              if (error instanceof BindingError) throw new AgentError(400, error.message);
              throw error;
            }
          }
        }
        const codex = this.deps.codex;
        if (!codex) throw new AgentError(400, CHATGPT_SWITCHED_OFF);
        if (!this.#health.online) throw new AgentError(503, "The desktop key layer is offline.");
        const status = await codex.account.status();
        signal?.throwIfAborted();
        if (!status.available)
          throw new AgentError(400, status.reason ?? "The ChatGPT plan is unavailable.");
        if (status.state !== "signed_in")
          throw new AgentError(400, "ChatGPT plan: sign in under Settings first.");
        selection = {
          kind: "chatgpt",
          model: settings.main.model,
          denyRead: Object.freeze([...(settings.codexDenyRead ?? [])]),
        };
        // The plan's own models need no key; only a Jev key can check where data goes.
        if (settings.purposeCheck !== "off")
          keys = (await this.deps.keyd.secrets().catch(() => [])).filter(isJevKey);
        signal?.throwIfAborted();
      } else {
        keys = await this.deps.keyd.secrets();
        signal?.throwIfAborted();
        const roles = this.resolveRoles(keys, settings);
        // Settings saved while keyd was away reach it here, before the task's first model call.
        await syncDayLimit(this.deps.keyd, settings.dayBudgetUSD).catch(() =>
          console.error("keyd's daily spending limit could not be updated"),
        );
        signal?.throwIfAborted();
        selection = {
          kind: "api",
          roles,
          pricing: pricingOf(roles),
          ...(settings.taskBudgetUSD === undefined
            ? {}
            : { initialBudget: settings.taskBudgetUSD }),
        };
      }
      signal?.throwIfAborted();
      const cell = this.#ready(cellId);
      if (this.deps.live.get(cellId))
        throw new AgentError(409, "a task is already running on this computer");
      // A conversation record that can't be read never keeps a task from starting.
      let continues: string | undefined;
      let earlier: string[] = [];
      try {
        continues = this.deps.conversations?.current() ?? undefined;
        earlier = continues ? (this.deps.conversations?.earlier(continues) ?? []) : [];
      } catch {
        console.error("the earlier conversation could not be read");
        continues = undefined;
        earlier = [];
      }
      const id = this.deps.eventLog.createSession(task.slice(0, 200));
      const session = new AgentSession(
        id,
        cellId,
        task,
        this.deps.eventLog,
        settings.autonomy,
        new RulesStore(this.deps.home),
      );
      session.earlier = earlier;
      session.actionLimit = settings.checkIns?.actions;
      const rt: Runtime = {
        session,
        selection,
        limits: agentLimits(settings.checkIns),
        skills: [],
        epoch: 0,
        initialized: false,
        serial: Promise.resolve(),
      };
      const judge = this.#judge(rt, settings, keys);
      session.purpose = new PurposeGate({
        taint: session.taint,
        purpose: () => session.currentPurpose,
        judge: () => judge,
        trusted: (host) => session.taskAutonomy.trusts(host),
      });
      this.sessions.set(id, session);
      this.#runtime.set(id, rt);
      try {
        this.deps.installSession?.(session, cell);
        session.append("session.start", {
          screen: { w: 1280 * cell.scale, h: 800 * cell.scale, scale: cell.scale },
          os: "linux",
          title: task.slice(0, 200),
          ...(continues ? { continues } : {}),
        });
        session.append("message.user", { messageId: ulid(), text: task, kind: "task" });
        if (earlier.length) session.taint.add("recall", "earlier conversation", earlier.join("\n"));
        this.#safety(rt);
        this.deps.live.start(
          cellId,
          id,
          (stop) => this.#run(rt, stop),
          this.deps.prepareDesktop ? (stop) => this.#prepareDesktop(rt, stop) : undefined,
        );
      } catch (error) {
        session.stop();
        await session.screensSettled().catch(() => {});
        this.sessions.delete(id);
        this.#runtime.delete(id);
        throw error;
      }
      try {
        this.deps.conversations?.adopt(id);
      } catch {
        console.error("the current conversation could not be saved");
      }
      return session;
    } finally {
      this.#starting.delete(cellId);
    }
  }
  #judge(rt: Runtime, settings: AgentSettings, keys: KeydRecord[]): PurposeJudge | undefined {
    const fast =
      rt.selection.kind === "api"
        ? rt.selection.roles.find((role) => role.role === "fast")
        : undefined;
    const choice = judgeChoice(settings.purposeCheck, keys, fast !== undefined);
    const jev = this.deps.jev;
    if (choice?.kind === "jev" && jev)
      return jevJudge((body, signal) => jev(choice.secretId, body, signal));
    if (choice?.kind !== "model" || !fast) return undefined;
    return modelJudge(
      gatewayCompletion(
        () => (rt.brain ? bindingOf(fast, rt.brain.surrogates) : undefined),
        () => (rt.brain ? { port: rt.brain.keydPort, token: rt.brain.proxyToken } : undefined),
      ),
    );
  }
  // Ends a finished task that waits for a follow-up, so the next message starts a new task in
  // whichever conversation is current. A task still at work is left alone and refused.
  async release(signal?: AbortSignal): Promise<void> {
    if (this.#starting.size) throw new AgentError(409, "A task is starting.");
    const live = [...this.#runtime.values()].filter((rt) => !rt.session.stopped);
    if (live.some((rt) => rt.selection.kind === "none" && rt.session.controlHeld))
      throw new AgentError(409, "Hand back the computer first.");
    const waiting = live.filter((rt) => rt.selection.kind !== "none");
    if (
      waiting.some((rt) => rt.session.status !== "idle" || rt.session.controlHeld || !rt.idleWait)
    )
      throw new AgentError(409, "Finish or stop the current task first.");
    for (const rt of waiting) {
      rt.released = true;
      rt.idleWait?.abort();
    }
    const settled = Promise.all(waiting.map((rt) => this.deps.live.settled(rt.session.id)));
    await (signal ? abortable(settled, signal) : settled);
  }
  // With no task at work, the user's own session holds the computer, in the current conversation,
  // until they hand it back. A task at work, or at rest, gives the user its own control.
  async hold(cellId: string, signal?: AbortSignal): Promise<TakeComputerReply> {
    if (!ULID_PATTERN.test(cellId)) throw new AgentError(400, "invalid computer id");
    this.#ready(cellId);
    if (this.#starting.has(cellId)) throw new AgentError(409, "a task is starting");
    const current = this.deps.live.get(cellId);
    if (current) {
      const live = this.sessions.get(current);
      if (!live || live.stopped) throw new AgentError(409, "the computer is changing hands");
      if (!this.holds(current) || live.controlHeld)
        return { sessionId: live.id, requestId: live.takeControl() };
      // A hold the user handed back is ending: the new one follows it.
      const settled = this.deps.live.settled(current);
      await (signal ? abortable(settled, signal) : settled);
    }
    const cell = this.#ready(cellId);
    if (this.#starting.has(cellId) || this.deps.live.get(cellId))
      throw new AgentError(409, "the computer is changing hands");
    let continues: string | undefined;
    let title: string | undefined;
    try {
      continues = this.deps.conversations?.current() ?? undefined;
      title = continues ? this.deps.conversations?.title?.(continues) : undefined;
    } catch {
      console.error("the earlier conversation could not be read");
      continues = undefined;
      title = undefined;
    }
    const id = this.deps.eventLog.createSession(HOLD_TITLE);
    const session = new AgentSession(id, cellId, "", this.deps.eventLog);
    const rt: Runtime = {
      session,
      selection: { kind: "none" },
      limits: agentLimits(undefined),
      skills: [],
      epoch: 0,
      initialized: false,
      serial: Promise.resolve(),
    };
    this.sessions.set(id, session);
    this.#runtime.set(id, rt);
    let requestId: string;
    try {
      this.deps.installSession?.(session, cell);
      session.append("session.start", {
        screen: { w: 1280 * cell.scale, h: 800 * cell.scale, scale: cell.scale },
        os: "linux",
        ...(title ? { title } : {}),
        ...(continues ? { continues } : {}),
      });
      session.setStatus("idle");
      // Before its run starts, which ends once the user no longer holds the computer.
      requestId = session.takeControl();
      this.deps.live.start(cellId, id, (stop) => this.#run(rt, stop));
    } catch (error) {
      session.stop();
      await session.screensSettled().catch(() => {});
      this.sessions.delete(id);
      this.#runtime.delete(id);
      throw error;
    }
    try {
      this.deps.conversations?.adopt(id);
    } catch {
      console.error("the current conversation could not be saved");
    }
    return { sessionId: id, requestId };
  }
  // The session is the user's own hold on the computer, with no task.
  holds(id: string): boolean {
    return this.#runtime.get(id)?.selection.kind === "none";
  }
  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }
  terminalOf(id: string): TerminalTaskSnapshot | undefined {
    const snapshot = this.#terminal.get(id);
    return snapshot ? structuredClone(snapshot) : undefined;
  }
  pauseTask(id: string, requestId: string): import("@localdot/protocol").PauseSnapshot {
    const rt = this.#runtime.get(id);
    if (!rt || rt.session.stopped || rt.selection.kind === "none")
      throw new AgentError(409, "task not available");
    return this.#safety(rt).request(requestId);
  }
  budgetHoldOf(id: string): "task" | "day" | undefined {
    const rt = this.#runtime.get(id);
    return rt && !rt.session.stopped ? budgetHold(rt) : undefined;
  }
  async resumeSafety(id: string, requestId: string, revision: number): Promise<void> {
    const rt = this.#runtime.get(id);
    if (!rt || rt.session.stopped) throw new AgentError(409, "task not available");
    if (budgetHold(rt) === "task") throw new AgentError(409, RAISE_BUDGET_FIRST);
    try {
      await this.#safety(rt).resume(requestId, revision);
    } catch {
      throw new AgentError(
        rt.session.safetyPause?.phase === "uncertain" ? 503 : 409,
        "Pause could not be resumed",
      );
    }
    // No task budget settles the shared daily limit, and only another model call can tell whether
    // it has room again, so this Resume also retries the refused call.
    if (budgetHold(rt) === "day" && !rt.session.stopped && !rt.session.controlHeld)
      rt.session.post("resume", "");
  }
  #safety(rt: Runtime): SafetyController {
    if (rt.safety) return rt.safety;
    rt.safety = new SafetyController(rt.session, {
      owner: () => (rt.brain ? { cellId: rt.brain.id, taskId: rt.session.id } : undefined),
      ownerBoundary: () => rt.brainOpening ?? Promise.resolve(),
      ready: () => {
        const cell = this.deps.cell(rt.session.cellId);
        if (
          cell?.state !== "ready" ||
          cell.paused ||
          this.#blockedCells.has(rt.session.cellId) ||
          this.deps.live.get(rt.session.cellId) !== rt.session.id ||
          rt.session.stopped ||
          rt.session.controlHeld ||
          !this.#health.online ||
          rt.pause === "auth" ||
          rt.pause === "keyd" ||
          budgetHold(rt) === "task"
        )
          throw new Error("task readiness changed");
      },
      modelAdmission: (id) => this.deps.keyd.modelAdmission(id),
      setModelAdmission: (id, write) => this.deps.keyd.setModelAdmission(id, write),
      persist: (pause) =>
        new SafetyIntentStore(this.deps.home).write(
          rt.session.id,
          rt.session.cellId,
          rt.session.autonomy,
          pause,
          rt.selection.kind === "api" ? "api" : "native",
        ),
      sleep: this.deps.sleep ?? sleep,
      mode: rt.selection.kind === "api" ? "api" : "native",
      ...(rt.selection.kind === "chatgpt"
        ? {
            native: {
              pause: (
                pause: Pick<import("@localdot/protocol").PauseSnapshot, "requestId" | "revision">,
              ) => {
                const driver = this.deps.codex?.driver;
                if (!driver?.pauseAtBoundary)
                  throw new Error("native Pause receipt is unavailable");
                return driver.pauseAtBoundary(rt.session, pause);
              },
              resume: (
                pause: Pick<import("@localdot/protocol").PauseSnapshot, "requestId" | "revision">,
                receipt: import("./codex/native-pause.ts").NativePauseReceipt,
              ) => {
                const driver = this.deps.codex?.driver;
                if (!driver?.resumeAtBoundary)
                  throw new Error("native Resume receipt is unavailable");
                return driver.resumeAtBoundary(rt.session, pause, receipt);
              },
              contain: () => this.contain(rt.session, "native_pause_uncertain"),
            },
          }
        : {}),
    });
    return rt.safety;
  }
  isChatgpt(id: string): boolean {
    return this.#runtime.get(id)?.selection.kind === "chatgpt";
  }
  skillsOf(id: string): SkillSummary[] {
    return structuredClone(this.#runtime.get(id)?.skills ?? []);
  }
  codexDenyReadOf(id: string): readonly string[] {
    const selection = this.#runtime.get(id)?.selection;
    return selection?.kind === "chatgpt" ? [...selection.denyRead] : [];
  }
  selectionOf(id: string) {
    const selection = this.#runtime.get(id)?.selection;
    if (!selection || selection.kind === "none") return undefined;
    return selection.kind === "chatgpt"
      ? { kind: "chatgpt" as const, model: selection.model }
      : taskSelection(selection.roles);
  }
  activeChatgptTasks(): number {
    return [...this.#runtime.values()].filter(
      (rt) =>
        rt.selection.kind === "chatgpt" &&
        !rt.session.stopped &&
        ["starting", "running", "waiting_user"].includes(rt.session.status),
    ).length;
  }
  // Auth owner calls this synchronously even when a journal fails or takeover is held.
  // It installs admission state; publishing a UI event is a separate best-effort operation.
  pauseForAuth(session: AgentSession, generation: number): void {
    const rt = this.#runtime.get(session.id);
    if (!rt || rt.session !== session || rt.selection.kind !== "chatgpt" || session.stopped) return;
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new AgentError(503, "The ChatGPT account generation is invalid.");
    // Repeated notification of the same mutation preserves an already accepted Resume.
    if (rt.authGeneration !== generation) rt.authResumeAfter = session.inboxSequence;
    rt.authGeneration = generation;
    rt.pause = "auth";
    rt.safety?.invalidate();
    rt.idleWait?.abort();
  }
  async waitForAuthResume(session: AgentSession): Promise<void> {
    const rt = this.#runtime.get(session.id);
    session.abort.signal.throwIfAborted();
    while (rt?.authResumeAfter !== undefined) {
      const after = rt.authResumeAfter;
      await session.waitForResume(after);
      if (rt.authResumeAfter === after) rt.authResumeAfter = undefined;
    }
  }
  async raiseBudget(id: string, budgetUSD: number): Promise<void> {
    if (
      !Number.isFinite(budgetUSD) ||
      budgetUSD <= 0 ||
      budgetUSD > 10_000 ||
      Math.round(budgetUSD * 1e6) < 1
    )
      throw new AgentError(400, "invalid task budget");
    const rt = this.#runtime.get(id);
    if (!rt) throw new AgentError(404, "no such live task");
    if (rt.selection.kind === "none") throw new AgentError(409, "no task is at work");
    if (rt.selection.kind === "chatgpt")
      throw new AgentError(409, "A ChatGPT plan task has no budget in localDot.");
    if (planOnly(rt.selection.roles))
      throw new AgentError(409, "This task uses your plan's limits.");
    await this.#exclusive(rt, async () => {
      const { session, brain } = rt;
      const generation = session.generation;
      const ready = () =>
        this.deps.cell(session.cellId)?.state === "ready" &&
        !this.deps.cell(session.cellId)?.paused &&
        !this.deps.cellBusy?.(session.cellId);
      if (
        !rt.initialized ||
        !brain ||
        !generation ||
        !session.isCurrent(generation) ||
        session.controlHeld ||
        session.pendingAsk ||
        !ready()
      )
        throw new AgentError(409, "the task is not ready to change its budget");
      await this.deps.keyd.beginTask(brain.id, id, budgetUSD);
      // An in-flight raise can finish after Stop/recovery; it must never resume obsolete work.
      if (!session.isCurrent(generation) || session.controlHeld || session.pendingAsk || !ready())
        throw new AgentError(409, "the task changed while updating its budget");
      // The raised limit settles the budget pause; a held Pause still waits for its own Resume.
      if (rt.pause === "budget") {
        rt.pause = undefined;
        rt.budgetScope = undefined;
      }
      if (!session.controlHeld) session.post("resume", "");
    });
  }
  async keydChanged(now: KeydHealth, _before: KeydHealth): Promise<void> {
    const changedBoot =
      now.online &&
      this.#lastBoot !== undefined &&
      now.bootId !== undefined &&
      now.bootId !== this.#lastBoot;
    this.#health = { ...now };
    if (now.online && now.bootId !== undefined) this.#lastBoot = now.bootId;
    for (const rt of this.#runtime.values()) {
      const session = rt.session;
      if (session.stopped) continue;
      if (session.safetyPause && (!now.online || changedBoot)) rt.safety?.invalidate();
      if (changedBoot && (session.generation || session.status !== "idle")) {
        rt.epoch += 1;
        if (session.generation) session.retireBrain(session.generation); // Fence before yielding.
        rt.backoff?.abort();
      } else if (
        now.online &&
        rt.pause === "keyd" &&
        session.status === "paused" &&
        !session.controlHeld
      ) {
        rt.pause = undefined;
        session.post("resume", "");
      } else if (!now.online && rt.pause === "model") rt.pause = "keyd";
    }
    this.#changed();
  }
  // Handler uncertainty cannot skip containment merely because it already fenced the session.
  contain(session: AgentSession, _reason: string): Promise<void> {
    const rt = this.#runtime.get(session.id);
    session.stop();
    this.#blockedCells.add(session.cellId);
    this.deps.fences?.capture(
      session.cellId,
      session.id,
      rt?.selection.kind === "chatgpt" ? "native" : "api",
    );
    if (rt?.containment) return rt.containment;
    const work = Promise.resolve()
      .then(() => this.deps.stopSession(session.id))
      .then((outcome) => {
        if (!outcome?.revoked || !(outcome.paused || (outcome.closed && outcome.stopped)))
          throw new CleanupUncertain("computer containment could not be confirmed");
      });
    if (rt) rt.containment = work;
    return work;
  }
  replacementOwner(cellId: string): {
    cellId: string;
    revision: number;
    fenced: boolean;
    taskEnded: boolean;
  } {
    const record = this.deps.fences?.record(cellId);
    return {
      cellId,
      revision: record?.revision ?? 0,
      fenced: !!record,
      taskEnded:
        !!record &&
        !this.#starting.has(cellId) &&
        !this.deps.live.get(cellId) &&
        !this.deps.live.idleOperationPending(cellId) &&
        ![...this.#runtime.values()].some((rt) => rt.session.cellId === cellId) &&
        (record.executor !== "native" || record.nativeRetired),
    };
  }
  async retireForReplacement(cellId: string): Promise<boolean> {
    const record = this.deps.fences?.record(cellId);
    if (!record || !this.replacementOwner(cellId).taskEnded) return false;
    if (!this.deps.brains.retireSession) return false;
    try {
      await this.deps.brains.retireSession(record.sessionId);
    } catch {
      return false;
    }
    return this.replacementOwner(cellId).taskEnded;
  }
  resetTaskDrained(cellId: string): boolean {
    try {
      if (!this.deps.fences?.isFenced(cellId)) return false;
      this.deps.fences.records();
      const fence = this.deps.fences.record(cellId);
      return (
        !this.#starting.has(cellId) &&
        !this.deps.live.get(cellId) &&
        !this.deps.live.idleOperationPending(cellId) &&
        ![...this.#runtime.values()].some((rt) => rt.session.cellId === cellId) &&
        (fence?.executor !== "native" || fence.nativeRetired)
      );
    } catch {
      return false;
    }
  }
  /** Called only after the reset owner durably fences the selected old identity. A successful
   * receipt drains task/native ownership; the computer adapter must still close its key grants
   * and independently verify container/browser retirement before erasing either volume. */
  async retireForReset(cellId: string): Promise<boolean> {
    if (!ULID_PATTERN.test(cellId) || !this.deps.fences?.isFenced(cellId)) return false;
    this.#blockedCells.add(cellId);
    // Preflight may still be awaiting account/key state. Its second #ready check will refuse
    // this fence, but no resource deletion is allowed until that admission has actually ended.
    if (this.#starting.has(cellId) || this.deps.live.idleOperationPending(cellId)) return false;
    const tasks = [...this.#runtime.values()].filter((rt) => rt.session.cellId === cellId);
    for (const rt of tasks) {
      this.deps.fences.capture(
        cellId,
        rt.session.id,
        rt.selection.kind === "chatgpt" ? "native" : "api",
      );
      rt.session.stop();
    }
    const retirement = (async () => {
      for (const rt of tasks) {
        const outcome = await this.deps.stopSession(rt.session.id);
        if (
          outcome &&
          (!outcome.revoked || !(outcome.paused || (outcome.closed && outcome.stopped)))
        )
          return false;
        await this.deps.live.settled(rt.session.id);
      }
      if (
        this.#starting.has(cellId) ||
        this.deps.live.get(cellId) ||
        this.deps.live.idleOperationPending(cellId) ||
        [...this.#runtime.values()].some((rt) => rt.session.cellId === cellId)
      )
        return false;
      // A global closed-admission condition is not proof that historical execution retired.
      this.deps.fences?.records();
      // Native uncertainty and a brain cleanup failure survive task settlement in the fence.
      if (this.deps.fences?.record(cellId)) return this.retireForReplacement(cellId);
      return true;
    })();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 10_000);
    try {
      return await abortable(retirement, deadline.signal);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  async close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      this.#unsubscribe();
      for (const rt of this.#runtime.values()) {
        rt.session.stop();
        this.deps.live.stop(rt.session.id);
      }
      this.#changed();
    }
    await Promise.all([...this.#runtime.keys()].map((id) => this.deps.live.settled(id)));
  }
  async #exclusive<T>(rt: Runtime, work: () => Promise<T>): Promise<T> {
    const current = rt.serial.then(work);
    rt.serial = current.then(
      () => {},
      () => {},
    );
    return current;
  }
  async #online(session: AgentSession): Promise<void> {
    while (!this.#health.online) {
      session.setStatus("paused");
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          this.#wake.delete(done);
          session.abort.signal.removeEventListener("abort", aborted);
          resolve();
        };
        const aborted = () => {
          this.#wake.delete(done);
          reject(session.abort.signal.reason);
        };
        this.#wake.add(done);
        session.abort.signal.addEventListener("abort", aborted, { once: true });
        if (session.stopped) aborted();
      });
    }
    session.abort.signal.throwIfAborted();
  }
  #changed(): void {
    for (const wake of [...this.#wake]) wake();
  }
  async #prepareDesktop(rt: Runtime, liveSignal: AbortSignal): Promise<void> {
    const { session } = rt;
    const stop = () => session.stop();
    liveSignal.addEventListener("abort", stop, { once: true });
    if (liveSignal.aborted) stop();
    try {
      await this.deps.waitForUploads(session.cellId, session.abort.signal);
      session.abort.signal.throwIfAborted();
      await this.deps.prepareDesktop?.(session);
      session.abort.signal.throwIfAborted();
    } catch (error) {
      await this.contain(session, "desktop_profile_uncertain").catch(() => {});
      throw error;
    } finally {
      liveSignal.removeEventListener("abort", stop);
    }
  }
  async #run(rt: Runtime, liveSignal: AbortSignal): Promise<void> {
    const { session } = rt;
    const stop = () => session.stop();
    liveSignal.addEventListener("abort", stop, { once: true });
    if (liveSignal.aborted) stop();
    let reason: "done" | "stopped" | "error" = "done";
    try {
      if (rt.selection.kind === "none") return await session.waitForControl();
      await this.deps.waitForUploads(session.cellId, session.abort.signal);
      session.abort.signal.throwIfAborted();
      const skills = await this.deps.installSkills(session.cellId, session.abort.signal);
      session.abort.signal.throwIfAborted();
      rt.skills = structuredClone(skills);
      let resume = false,
        crashes = 0;
      while (!session.stopped) {
        const authAfter = rt.authResumeAfter;
        if (authAfter !== undefined) {
          await this.waitForAuthResume(session);
          resume = true;
        }
        await session.waitForSafety();
        await session.waitForControl();
        await session.waitForTools();
        await this.deps.waitForUploads(session.cellId, session.abort.signal);
        await this.#online(session);
        const epoch = rt.epoch;
        let code: number | undefined;
        try {
          code =
            rt.selection.kind === "chatgpt"
              ? await this.deps.codex?.driver.run(session, { model: rt.selection.model, resume })
              : await this.#brainRun(rt, skills, resume);
        } catch (error) {
          if (uncertain(error)) throw error;
          if (session.stopped) break;
          if (rt.epoch !== epoch) {
            resume = true;
            continue;
          }
          if (error instanceof KeydUnavailableError) {
            rt.pause = "keyd";
            this.#health = { online: false };
            session.setStatus("paused");
            session.append("agent.state", { state: "paused", reason: "keyd unavailable" });
            continue;
          }
          code = undefined;
        }
        resume = true;
        if (session.stopped) break;
        if (rt.epoch !== epoch) continue;
        // A vanished caller still leaves the user in control; no idle/crash state may replace it.
        const heldOnExit = session.controlHeld;
        await session.waitForControl();
        if (heldOnExit || rt.authResumeAfter !== undefined) continue;
        if (code === BRAIN_DONE || code === BRAIN_GAVE_UP) {
          crashes = 0;
          session.append(
            "agent.state",
            session.actionLimitReached
              ? { state: "idle", reason: STALL.actionLimit }
              : code === BRAIN_DONE
                ? { state: "done" }
                : { state: "idle", reason: "gave up" },
          );
          session.setStatus("idle");
          const idleWait = new AbortController();
          rt.idleWait = idleWait;
          try {
            const idleMs = this.deps.idleMs ?? IDLE_MS;
            let asked = await session.waitForUser(idleMs, idleWait.signal);
            // While the user has the computer, a finished task waits for them rather than the clock.
            while (!asked && session.controlHeld) {
              await session.waitForControl(idleWait.signal);
              asked = await session.waitForUser(idleMs, idleWait.signal);
            }
            if (!asked) break;
          } catch (error) {
            if (rt.released) break;
            if (!idleWait.signal.aborted || rt.authResumeAfter === undefined) throw error;
          } finally {
            if (rt.idleWait === idleWait) rt.idleWait = undefined;
          }
        } else {
          const backoff = RESTART_BACKOFF_MS[crashes++];
          if (backoff === undefined) {
            reason = "error";
            session.append("agent.state", {
              state: "error",
              reason:
                rt.selection.kind === "chatgpt"
                  ? "The ChatGPT task kept stopping."
                  : "the brain kept crashing",
            });
            break;
          }
          session.append("agent.state", {
            state: "error",
            reason:
              rt.selection.kind === "chatgpt"
                ? `Codex stopped (exit ${code ?? "unknown"}); restarting`
                : "the brain stopped; restarting from saved history",
          });
          const interrupted = new AbortController();
          rt.backoff = interrupted;
          try {
            await (this.deps.sleep ?? sleep)(
              backoff,
              AbortSignal.any([session.abort.signal, interrupted.signal]),
            );
          } catch (error) {
            if (session.stopped || !interrupted.signal.aborted) throw error;
          } finally {
            if (rt.backoff === interrupted) rt.backoff = undefined;
          }
        }
      }
    } catch (error) {
      reason = session.stopped && !uncertain(error) ? "stopped" : "error";
      if (uncertain(error)) await this.contain(session, "brain_cleanup_uncertain").catch(() => {});
      if (!session.stopped) {
        try {
          session.append("agent.state", { state: "error", reason: "the task could not continue" });
        } catch {
          /* Still stop below. */
        }
      }
    } finally {
      await this.deps.waitForUploads(session.cellId);
      // Cleanup uncertainty launches containment above. Retain ownership even when closing the
      // brain failed and skipped its ordinary drain; containment independently bounds its wait.
      await session.toolsSettled();
      if (rt.selection.kind === "chatgpt") {
        try {
          await this.deps.codex?.ended?.(session.id);
        } catch {
          reason = "error";
          this.#blockedCells.add(session.cellId);
          this.deps.fences?.capture(session.cellId, session.id, "native");
        }
      }
      if (
        rt.selection.kind === "chatgpt" &&
        this.deps.codex?.driver.retirementConfirmed?.(session.id) === true
      )
        this.deps.fences?.confirmNativeRetirement(session.cellId, session.id);
      if (session.stopped && reason === "done") reason = "stopped";
      try {
        if (reason === "done") {
          if (!(await session.finish())) reason = "stopped";
        } else {
          session.stop();
          await session.screensSettled();
        }
      } catch {
        reason = "error";
        session.stop();
        await session.screensSettled().catch(() => {});
      }
      // Its tools have settled, so a Pause that Stop left unsettled must not fence the computer at
      // the next start. Named cleanup uncertainty fenced it above; an unconfirmed Stop never fences.
      try {
        new SafetyIntentStore(this.deps.home).remove(session.id, session.cellId);
      } catch {
        console.error("agent safety intent could not be cleared");
      }
      try {
        session.append("session.end", { reason });
        const models = this.selectionOf(session.id);
        // Only a successfully recorded terminal event permits history authority. The public
        // selection has no key/pricing/credential fields and is copied away from the runtime.
        this.#terminal.set(session.id, {
          sessionId: session.id,
          cellId: session.cellId,
          status: "ended",
          toolCalls: session.toolCalls,
          ...(models ? { models: structuredClone(models) } : {}),
        });
        if (this.#terminal.size > TERMINAL_SNAPSHOTS) {
          const oldest = this.#terminal.keys().next().value;
          if (oldest) this.#terminal.delete(oldest);
        }
      } catch {
        console.error("agent session end could not be recorded");
      }
      liveSignal.removeEventListener("abort", stop);
      this.sessions.delete(session.id);
      this.#runtime.delete(session.id);
    }
  }
  async #brainRun(
    rt: Runtime,
    skills: SkillSummary[],
    resume: boolean,
  ): Promise<number | undefined> {
    const { session } = rt;
    const selection = rt.selection;
    if (selection.kind !== "api") throw new Error("The task model route changed.");
    const generation = session.beginBrain();
    session.setStatus("running");
    let brain: BrainCell | undefined;
    let aliased = false;
    let publishOwner!: () => void;
    const opening = new Promise<void>((resolve) => {
      publishOwner = resolve;
    });
    rt.brainOpening = opening;
    const settledOwner = () => {
      publishOwner();
      if (rt.brainOpening === opening) rt.brainOpening = undefined;
    };
    try {
      // beginBrain synchronously moves new uploads onto generation-owned ToolLeases. Drain any
      // idle upload admitted after the earlier wait before opening the replacement brain.
      await session.prepareScreens(generation);
      await this.deps.waitForUploads(session.cellId, generation.signal);
      await this.#exclusive(rt, async () => {
        session.check(generation);
        brain = await this.deps.brains.open({
          sessionId: session.id,
          secrets: [
            ...new Set(selection.roles.flatMap((role) => (role.keyId ? [role.keyId] : []))),
          ],
          pricing: selection.pricing,
          initialModelAdmission: "paused",
          ...(selection.initialBudget === undefined ? {} : { budgetUSD: selection.initialBudget }),
          signal: generation.signal,
        });
        session.check(generation);
        rt.brain = brain;
        rt.initialized = true;
        session.restoreDelivered(this.deps.transcripts);
        const models = Object.fromEntries(
          selection.roles.map((role) => [role.role, bindingOf(role, brain?.surrogates ?? {})]),
        ) as Record<Role, ModelBinding>;
        const memory = this.deps.memory.readBoth();
        taintMemory(session.taint, memory);
        const boot = BootConfig.parse({
          sessionId: session.id,
          task: session.task,
          models: {
            main: models.main,
            ...(models.fast ? { fast: models.fast } : {}),
            ...(models.local ? { local: models.local } : {}),
          },
          proxy: { url: brain.proxyUrl, token: brain.proxyToken },
          memory,
          skills,
          limits: this.deps.limits ?? rt.limits,
          resume,
          inboxAfter: session.delivered,
          ...(session.earlier.length ? { earlier: [...session.earlier] } : {}),
        });
        session.publishBrain(generation, {
          toolToken: brain.toolToken,
          boot,
          brainCellId: brain.id,
        });
        this.deps.live.alias(brain.id, session.id);
        aliased = true;
        // BrainCells creates a closed generation. Publish ownership before opening it, so
        // any concurrent Pause closes this exact owner and the process cannot sample early.
        const gate = await this.deps.keyd.modelAdmission(brain.id);
        session.check(generation);
        if (gate.taskId !== session.id || gate.retired || !gate.paused || gate.active !== 0)
          throw new Error("brain model admission unavailable");
        if (!session.safetyPause) {
          try {
            const opened = await this.deps.keyd.setModelAdmission(brain.id, {
              taskId: session.id,
              generationId: gate.generationId,
              state: "open",
              expectedEpoch: gate.epoch,
            });
            session.check(generation);
            if (
              opened.taskId !== session.id ||
              opened.generationId !== gate.generationId ||
              opened.paused ||
              opened.retired
            )
              throw new Error("brain admission was not opened");
          } catch (error) {
            if (!session.safetyPause) throw error;
          }
        }
        if (session.safetyPause) {
          const closed = await this.deps.keyd.setModelAdmission(brain.id, {
            taskId: session.id,
            generationId: gate.generationId,
            state: "paused",
          });
          session.check(generation);
          if (!closed.paused || closed.retired || closed.generationId !== gate.generationId)
            throw new Error("brain pause was not confirmed");
        }
        settledOwner();
        await this.deps.brains.start(brain, generation.signal);
        session.check(generation);
      });
      if (!brain) throw new Error("brain did not open");
      return await this.deps.brains.exited(brain, generation.signal);
    } finally {
      settledOwner();
      session.retireBrain(generation);
      const owned = brain;
      if (owned && session.safetyPause && !session.stopped) rt.safety?.invalidate();
      if (owned) {
        await this.#exclusive(rt, async () => {
          try {
            await this.deps.brains.close(owned);
          } catch {
            throw new CleanupUncertain("brain cleanup could not be confirmed");
          } finally {
            if (aliased) this.deps.live.unalias(owned.id, session.id);
            if (rt.brain === owned) rt.brain = undefined;
          }
        });
      }
      await session.toolsSettled();
    }
  }
}
