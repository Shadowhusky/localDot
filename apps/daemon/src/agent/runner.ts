import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { CHATGPT_SWITCHED_OFF } from "@localdot/codex-harness";
import {
  type AgentLimits,
  type AgentRoleChoice,
  type AutonomyPolicy,
  BootConfig,
  type CheckIns,
  type ClaudeCodeStatus,
  type ConversationLive,
  clipText,
  DEFAULT_AGENT_LIMITS,
  DEFAULT_PERSONA,
  DEFAULT_RESEARCH_BUDGET,
  freezeAutonomy,
  isJevKey,
  type KeydRecord,
  LIVE_ACTIVITY_CHARS,
  type ModelBinding,
  type ModelOptions,
  type PersonaId,
  type PremiumSpeed,
  personaOf,
  type ReasoningEffort,
  type RecentLine,
  ReviseLink,
  SESSION_PAUSE_REASONS,
  SessionOrigin,
  SessionRun,
  type SkillSummary,
  STALL,
  type SubagentResume,
  type TakeComputerReply,
  type TaskModelSelection,
  type TaskPricing,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import { type Catalog, modelControls, modelOptionsProblem } from "@localdot/providers";
import type { CellSummary } from "../cells/types.ts";
import { NO_CONNECTORS, type TaskConnectors } from "../connectors/hub.ts";
import type { EventLog } from "../event-log.ts";
import type { StopOutcome } from "../gateway/kill-switch.ts";
import type { LiveSessions } from "../gateway/live.ts";
import { type KeydClient, KeydUnavailableError } from "../keyd/client.ts";
import { type KeydHealth, vaultLocked } from "../keyd/monitor.ts";
import {
  activeRoles,
  BindingError,
  bindingOf,
  CHATGPT,
  CLAUDE_CODE,
  checkPlanChoices,
  planOnly,
  pricingOf,
  type ResolvedRole,
  type Role,
  resolveRole,
  taskSelection,
} from "./bindings.ts";
import { type BrainCell, type BrainCells, BrainCleanupError } from "./brain-cell.ts";
import type { ClaudeCodeAnswer } from "./claude-code/answer.ts";
import { ClaudeCodeCleanupError, type ClaudeCodeDriver } from "./claude-code/driver.ts";
import type { CodexAccount } from "./codex/account.ts";
import { CodexCleanupError, type CodexDriver } from "./codex/driver.ts";
import type { ComputerTurns } from "./computer-turn.ts";
import type { ConversationNames, Conversations } from "./conversation.ts";
import {
  type Ask,
  DOT_WAIT_MS,
  type FirstLook,
  firstLook,
  LOOK_MS,
  leastEffort,
} from "./first-look.ts";
import type { MemoryStore } from "./memory.ts";
import { providerNotice } from "./provider-notice.ts";
import type { RecentActivity } from "./recent-activity.ts";
import { ResearchLog } from "./research.ts";
import { SafetyController } from "./safety/controller.ts";
import type { ComputerFences } from "./safety/fences.ts";
import { gatewayCompletion } from "./safety/judge-model.ts";
import {
  jevApprovalRequest,
  jevFits,
  jevJudge,
  jevLocalChangeRequest,
  jevNavigationRequest,
  modelJudge,
} from "./safety/judges.ts";
import { judgeChoice, PurposeGate, type PurposeJudge, unreadableJudge } from "./safety/purpose.ts";
import { RulesStore } from "./safety/rules.ts";
import { SafetyIntentStore } from "./safety/store.ts";
import { taintMemory } from "./safety/taint.ts";
import { visualNavigation } from "./safety/visual-target.ts";
import { AgentSession, abortable, SessionStoppedError } from "./session.ts";
import { AgentSettings } from "./settings.ts";
import {
  SideQuestionError,
  sideAnswerText,
  sideQuestionEvents,
  sideQuestionPrompt,
} from "./side-question.ts";
import { type DayLimitKeyd, syncDayLimit } from "./spending.ts";
import { resumable, unfinishedIn } from "./subagents.ts";
import type { TranscriptStore } from "./transcript.ts";

export const BRAIN_DONE = 0;
export const BRAIN_GAVE_UP = 3;
const RESTART_BACKOFF_MS = [2000, 4000, 8000];
const IDLE_MS = 30 * 60 * 1000;
const TERMINAL_SNAPSHOTS = 256;
const SESSION_PAUSES = new Set<string | undefined>(SESSION_PAUSE_REASONS);
export const RAISE_BUDGET_FIRST = "Raise this task's budget before resuming it.";
export const CLAUDE_CODE_OFF = "Claude Code isn't available on this computer.";
// Recovery waits own no user decision or desktop control. They can be retired
// cleanly when the user sends a new task or chooses another conversation.
function recoverable(session: AgentSession): boolean {
  return (
    session.status === "paused" &&
    !session.controlHeld &&
    !session.pendingAsk &&
    !session.pendingApproval &&
    !session.safetyPause
  );
}
// What Replay calls the user's own time on the computer.
const HOLD_TITLE = "You used the computer";
// How long a sign-in waits for the web browser to start before saying to try again.
export const SIGN_IN_BROWSER_WAIT_MS = 20_000;
const BROWSER_UNAVAILABLE = "The web browser couldn't open. Try again in a moment.";
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
export interface TaskStartOptions {
  // Server-selected shared-link model, never arbitrary client request fields.
  readonly main?: import("@localdot/protocol").AgentRoleChoice;
  readonly origin?: SessionOrigin;
  // Replaces the user's autonomy for this task.
  readonly autonomy?: AutonomyPolicy;
  // Replaces the user's task budget for this task.
  readonly budgetUSD?: number;
  // Marks the session unattended: approval cards wait this long, then the step is refused.
  readonly approvalWindowMs?: number;
  // 0..IDLE_MS; routines pass 0 so the task ends right after done.
  readonly idleMs?: number;
  readonly run?: SessionRun;
  // The handed-over file this task revises, from a task that has ended.
  readonly revises?: ReviseLink;
  // Research mode, within the user's research budget.
  readonly research?: boolean;
  // The conversation's latest task, or null for a new one; left out, the current conversation.
  readonly continues?: string | null;
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
  eventLog: Pick<EventLog, "createSession" | "append" | "subscribe" | "logFile">;
  live: Pick<
    LiveSessions,
    | "start"
    | "get"
    | "alias"
    | "unalias"
    | "settled"
    | "stop"
    | "idleOperationPending"
    | "sessionsOn"
    | "busy"
    | "cellOf"
    | "lease"
    | "browserHolder"
  >;
  // A task's live status changed; undefined once it has ended.
  liveChanged?(sessionId: string, live: ConversationLive | undefined): void;
  // Turns on the computer its tasks share, and which of its windows are whose.
  computer?: Pick<ComputerTurns, "take" | "owners">;
  cell(cellId: string): CellSummary | undefined;
  cellBusy?(cellId: string): boolean;
  installSession?(session: AgentSession, cell: CellSummary, freshTab?: boolean): void;
  // Starts the computer's web browser, or finds it running.
  startBrowser?(cellId: string): Promise<void>;
  brains: Pick<BrainCells, "open" | "start" | "exited" | "close"> &
    Partial<Pick<BrainCells, "retireSession">>;
  keyd: Pick<KeydClient, "secrets" | "beginTask" | "modelAdmission" | "setModelAdmission"> &
    DayLimitKeyd;
  keydHealth?(): KeydHealth;
  settings(): AgentSettings;
  catalog(): Catalog | undefined;
  memory: Pick<MemoryStore, "bootMemory">;
  // The connected apps' tools a task is shown, as the user's settings stand when its model starts.
  connectors?(): TaskConnectors;
  recentActivity?: Pick<RecentActivity, "list">;
  transcripts: TranscriptStore;
  conversations?: Pick<Conversations, "current" | "earlier" | "adopt"> &
    Partial<Pick<Conversations, "names" | "persona">>;
  installSkills(cellId: string, signal: AbortSignal, persona?: PersonaId): Promise<SkillSummary[]>;
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
  claudeCode?: {
    driver: Pick<ClaudeCodeDriver, "run"> &
      Partial<
        Pick<ClaudeCodeDriver, "pauseAtBoundary" | "resumeAtBoundary" | "retirementConfirmed">
      >;
    status(): Promise<
      Pick<ClaudeCodeStatus, "state" | "reason"> & Partial<Pick<ClaudeCodeStatus, "models">>
    >;
    // Asks a task's fast model on the plan one question, with no tools.
    answer?(fast: { model: string; options?: ModelOptions }): ClaudeCodeAnswer;
  };
  // Asks a model billed per token one short question before the task's brain starts.
  quickModel?(
    role: ResolvedRole,
    system: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string>;
}
// "none": the user's own hold on the computer, which no model works on.
type ModelSelection =
  | { kind: "api"; roles: readonly ResolvedRole[]; pricing: TaskPricing; initialBudget?: number }
  | {
      kind: "chatgpt";
      model: string;
      options?: ModelOptions;
      // The account's own name for the chosen speed's tier.
      serviceTier?: string;
      denyRead: readonly string[];
    }
  | {
      kind: "claude-code";
      model: string;
      options?: ModelOptions;
      fast?: { model: string; options?: ModelOptions };
      // A new conversation's first look: the fast model, else the main one, at its least thinking.
      quick: { model: string; options?: ModelOptions };
    }
  | { kind: "none" };
// A plan's account says what each of its models takes: its efforts and speeds replace the bundled
// ones. Unsaid, the bundled ones stand.
function planOptionsProblem(
  provider: typeof CHATGPT | typeof CLAUDE_CODE,
  choice: AgentRoleChoice,
  account?: { efforts?: readonly ReasoningEffort[]; speeds?: readonly PremiumSpeed[] },
): string | undefined {
  const { options, model } = choice;
  if (
    options?.reasoningEffort &&
    account?.efforts &&
    !account.efforts.includes(options.reasoningEffort)
  )
    return "This account model does not support the selected effort. Choose an available level in Settings.";
  const fallback = modelControls(provider, model);
  const speeds =
    account?.speeds ??
    (fallback.speeds ?? []).filter((speed): speed is PremiumSpeed => speed !== "standard");
  if (
    (options?.speed === "fast" || options?.speed === "ultrafast") &&
    !speeds.includes(options.speed)
  )
    return "This account model doesn't offer that speed. Choose another in Settings.";
  return modelOptionsProblem(provider, model, options, 16000, {
    ...fallback,
    efforts: [...(account?.efforts ?? fallback.efforts)],
    speeds: speeds.length ? ["standard", ...speeds] : undefined,
  });
}
interface Runtime {
  session: AgentSession;
  selection: ModelSelection;
  // The dot chosen when the task started, or the user's switch; its skills and instructions hold
  // from the agent's next start.
  persona?: PersonaId;
  // Auto's pick for a new conversation, or nothing once it is too late to wait for one.
  choosing?: Promise<FirstLook>;
  limits: AgentLimits;
  skills: SkillSummary[];
  epoch: number;
  brain?: BrainCell;
  brainOpening?: Promise<void>;
  initialized: boolean;
  failure?: { reason?: string; detail?: string };
  completion?: "complete" | "blocked";
  providerNotice?: string;
  serial: Promise<void>;
  pause?: "budget" | "keyd" | "model" | "auth" | "keys";
  budgetScope?: "task" | "day";
  authResumeAfter?: number;
  authGeneration?: number;
  idleWait?: AbortController;
  containment?: Promise<void>;
  safety?: SafetyController;
  backoff?: AbortController;
  // Ended from its wait for a follow-up, because the user moved to another conversation.
  released?: boolean;
  idleMs?: number;
  // What it is doing now, in a line, and the live status last told.
  activity?: string;
  live?: ConversationLive;
}
interface FastModel {
  readonly provider: string;
  readonly model: string;
  // Whether it can answer now: a fast model on an API key answers only through a running brain.
  ready(): boolean;
  ask(system: string, prompt: string, signal: AbortSignal): Promise<string>;
}
class CleanupUncertain extends Error {}
function uncertain(error: unknown): boolean {
  return (
    error instanceof BrainCleanupError ||
    error instanceof CodexCleanupError ||
    error instanceof ClaudeCodeCleanupError ||
    error instanceof CleanupUncertain ||
    (error instanceof AggregateError && error.errors.some(uncertain))
  );
}
const sleep = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal });
const budgetHold = (rt: Runtime) =>
  rt.pause === "budget" ? (rt.budgetScope ?? "task") : undefined;
// A plan's own app does the model's work outside localDot's brain cell and key layer.
const native = (selection: ModelSelection) =>
  selection.kind === "chatgpt" || selection.kind === "claude-code";

// One serialized lifecycle owns each task. Generation retirement is synchronous; Docker and
// keyd settlement happen afterward, before a replacement can be admitted.
export class AgentRunner {
  readonly sessions = new Map<string, AgentSession>();
  readonly #runtime = new Map<string, Runtime>();
  // Bounded daemon-lifetime history only: never keep AgentSession, leases, brain IDs or keys.
  readonly #terminal = new Map<string, TerminalTaskSnapshot>();
  readonly #starting = new Set<string>();
  // Starts on one computer are admitted one at a time.
  readonly #admitting = new Map<string, Promise<void>>();
  readonly #watched = new Map<string, () => void>();
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
      const doing =
        event.type === "tool.start"
          ? event.data.title
          : event.type === "step.start"
            ? event.data.intent
            : event.type === "action.intent"
              ? event.data.label
              : undefined;
      if (doing) rt.activity = clipText(doing, LIVE_ACTIVITY_CHARS);
      queueMicrotask(() => this.#told(rt));
      if (event.type === "budget.exceeded") {
        rt.pause = "budget";
        rt.budgetScope = event.data.scope;
      }
      if (event.type === "task.result") rt.completion = event.data.outcome ?? "complete";
      // keyd refused a saved key the task's computer asked for while the vault is locked.
      if (event.type === "key.use" && event.data.decision === "deny" && vaultLocked(this.#health))
        rt.session.lockKeys();
      if (event.type !== "agent.state") return;
      if (event.data.state === "error") rt.failure = event.data;
      else if (["thinking", "acting", "observing", "done"].includes(event.data.state))
        rt.failure = undefined;
      if (event.data.state === "paused") {
        const notice = providerNotice(event.data.reason, event.data.detail);
        if (notice && rt.providerNotice !== notice) {
          rt.providerNotice = notice;
          rt.session.append("message.assistant", { messageId: ulid(), text: notice });
        }
        if (rt.selection.kind === "chatgpt" && event.data.reason === "chatgpt account changed") {
          const generation = this.deps.codex?.authGeneration?.();
          if (generation !== undefined) this.pauseForAuth(rt.session, generation);
          else {
            if (rt.pause !== "auth") rt.authResumeAfter = rt.session.inboxSequence;
            rt.pause = "auth";
            rt.idleWait?.abort();
          }
        } else if (event.data.reason === STALL.keysLocked) {
          rt.pause = "keys";
          rt.session.lockKeys(false);
        } else if (!SESSION_PAUSES.has(event.data.reason))
          rt.pause =
            event.data.reason === "budget" ? "budget" : this.#health.online ? "model" : "keyd";
      } else if (["thinking", "acting", "observing"].includes(event.data.state)) {
        rt.providerNotice = undefined;
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
    const active = activeRoles(snapshot);
    const roles: ResolvedRole[] = [];
    for (const role of ["main", "fast", "local"] as const satisfies readonly Role[]) {
      const choice = active[role];
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
  async start(
    cellId: string,
    task: string,
    signal?: AbortSignal,
    options: TaskStartOptions = {},
  ): Promise<AgentSession> {
    if (!ULID_PATTERN.test(cellId) || !task.trim() || task.length > 8000)
      throw new AgentError(400, "invalid task");
    const origin =
      options.origin === undefined ? undefined : SessionOrigin.safeParse(options.origin);
    if (origin && !origin.success) throw new AgentError(400, "invalid task origin");
    const run = options.run === undefined ? undefined : SessionRun.safeParse(options.run);
    if (run && !run.success) throw new AgentError(400, "invalid task run");
    const revises =
      options.revises === undefined ? undefined : ReviseLink.safeParse(options.revises);
    if (revises && !revises.success) throw new AgentError(400, "invalid revised file");
    const budget = options.budgetUSD;
    if (
      budget !== undefined &&
      !(Number.isFinite(budget) && budget > 0 && budget <= 10_000 && Math.round(budget * 1e6) >= 1)
    )
      throw new AgentError(400, "invalid task budget");
    const idle = options.idleMs;
    if (idle !== undefined && !(Number.isSafeInteger(idle) && idle >= 0 && idle <= IDLE_MS))
      throw new AgentError(400, "invalid idle time");
    const window = options.approvalWindowMs;
    if (
      window !== undefined &&
      !(Number.isSafeInteger(window) && window >= 60_000 && window <= 14_400_000)
    )
      throw new AgentError(400, "invalid approval window");
    let autonomyOverride: AutonomyPolicy | undefined;
    if (options.autonomy !== undefined) {
      try {
        autonomyOverride = freezeAutonomy(options.autonomy);
      } catch {
        throw new AgentError(400, "invalid task autonomy");
      }
    }
    this.#ready(cellId);
    signal?.throwIfAborted();
    const before = this.#admitting.get(cellId) ?? Promise.resolve();
    const turn = Promise.withResolvers<void>();
    const admitted = before.then(() => turn.promise);
    this.#admitting.set(cellId, admitted);
    this.#starting.add(cellId);
    const admittedNext = () => {
      turn.resolve();
      if (this.#admitting.get(cellId) !== admitted) return;
      this.#admitting.delete(cellId);
      this.#starting.delete(cellId);
    };
    try {
      await (signal ? abortable(before, signal) : before);
    } catch (error) {
      admittedNext();
      throw error;
    }
    try {
      // Capture at request admission, before prior-task retirement or preflight can await.
      const settings = AgentSettings.parse({
        ...this.deps.settings(),
        ...(options.main ? { main: options.main, fast: undefined, local: undefined } : {}),
      });
      // A routine's run is its own thread: it neither continues nor takes over the user's
      // conversation. A conversation record that can't be read never keeps a task from starting.
      let continues: string | undefined;
      if (!origin)
        try {
          continues =
            options.continues === undefined
              ? (this.deps.conversations?.current() ?? undefined)
              : (options.continues ?? undefined);
        } catch {
          console.error("the earlier conversation could not be read");
        }
      // The conversation's own task makes way for the new one; the computer's other tasks go on.
      const previous = continues ? this.sessions.get(continues) : undefined;
      if (previous && !previous.stopped) {
        if (this.holds(previous.id) && previous.pendingTakeover) {
          if (!(await previous.handback(previous.pendingTakeover, undefined, signal)))
            throw new AgentError(409, "The computer is still changing hands. Try sending again.");
        }
        if ((previous.status !== "idle" && !recoverable(previous)) || previous.controlHeld)
          throw new AgentError(
            409,
            "That conversation's task is still at work: message it instead.",
          );
        // A hold the user handed back ends by itself. A finished task ends as it would after its
        // idle time.
        const waiting = this.#runtime.get(previous.id);
        if (waiting?.idleWait) {
          waiting.released = true;
          waiting.idleWait.abort();
        } else if (!this.holds(previous.id)) previous.cancel();
        await (signal
          ? abortable(this.deps.live.settled(previous.id), signal)
          : this.deps.live.settled(previous.id));
      }
      let selection: ModelSelection;
      // Undefined when the saved keys couldn't be read.
      let keys: KeydRecord[] | undefined = [];
      try {
        checkPlanChoices(settings);
      } catch (error) {
        if (error instanceof BindingError) throw new AgentError(400, error.message);
        throw error;
      }
      if (settings.main?.provider === CLAUDE_CODE) {
        const claude = this.deps.claudeCode;
        if (!claude) throw new AgentError(400, CLAUDE_CODE_OFF);
        const status = await claude.status();
        signal?.throwIfAborted();
        if (status.state !== "signed_in")
          throw new AgentError(400, status.reason ?? "Claude Code isn't ready.");
        const account = (choice: AgentRoleChoice) => {
          const model = status.models?.find((row) => row.id === choice.model);
          return (
            model && {
              ...(model.efforts ? { efforts: model.efforts } : {}),
              ...(model.fast !== undefined ? { speeds: model.fast ? ["fast" as const] : [] } : {}),
            }
          );
        };
        const problem = planOptionsProblem(CLAUDE_CODE, settings.main, account(settings.main));
        if (problem) throw new AgentError(400, problem);
        // Claude Code keeps its own history, so a fast model on the plan answers the purpose check.
        const fast = activeRoles(settings).fast;
        const fastProblem = fast && planOptionsProblem(CLAUDE_CODE, fast, account(fast));
        if (fastProblem) throw new AgentError(400, `fast model: ${fastProblem}`);
        const quick = fast ?? settings.main;
        const least = leastEffort(
          account(quick)?.efforts ?? modelControls(CLAUDE_CODE, quick.model).efforts,
        );
        selection = {
          kind: "claude-code",
          model: settings.main.model,
          options: settings.main.options,
          ...(fast ? { fast: { model: fast.model, options: fast.options } } : {}),
          quick: { model: quick.model, ...(least ? { options: { reasoningEffort: least } } : {}) },
        };
      } else if (settings.main?.provider === CHATGPT) {
        const codex = this.deps.codex;
        if (!codex) throw new AgentError(400, CHATGPT_SWITCHED_OFF);
        if (!this.#health.online) throw new AgentError(503, "The desktop key layer is offline.");
        const status = await codex.account.status();
        signal?.throwIfAborted();
        if (!status.available)
          throw new AgentError(400, status.reason ?? "The ChatGPT plan is unavailable.");
        if (status.state !== "signed_in")
          throw new AgentError(400, "ChatGPT plan: sign in under Settings first.");
        const capability = status.models?.find((model) => model.id === settings.main?.model);
        const tiers = capability?.tiers ?? {};
        const problem = planOptionsProblem(CHATGPT, settings.main, {
          ...(capability?.efforts ? { efforts: capability.efforts } : {}),
          speeds: (["fast", "ultrafast"] as const).filter((speed) => tiers[speed]),
        });
        if (problem) throw new AgentError(400, problem);
        const speed = settings.main.options?.speed;
        const serviceTier = speed === "fast" || speed === "ultrafast" ? tiers[speed] : undefined;
        selection = {
          kind: "chatgpt",
          model: settings.main.model,
          options: settings.main.options,
          ...(serviceTier ? { serviceTier } : {}),
          denyRead: Object.freeze([...(settings.codexDenyRead ?? [])]),
        };
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
          ...((budget ?? settings.taskBudgetUSD) === undefined
            ? {}
            : { initialBudget: budget ?? settings.taskBudgetUSD }),
        };
      }
      // A plan's own models need no key; only a Jev key can check where data goes. Keys that
      // can't be read leave the check unable to answer, never off.
      if (native(selection) && settings.purposeCheck !== "off")
        keys = await this.deps.keyd.secrets().then(
          (all) => all.filter(isJevKey),
          () => undefined,
        );
      signal?.throwIfAborted();
      const cell = this.#ready(cellId);
      let earlier: string[] = [];
      if (continues)
        try {
          earlier = this.deps.conversations?.earlier(continues) ?? [];
        } catch {
          console.error("the earlier conversation could not be read");
          continues = undefined;
        }
      let recent: RecentLine[] = [];
      if (settings.recentActivity !== "off" && this.deps.recentActivity)
        try {
          recent = this.deps.recentActivity.list().map(({ sessionId: _, ...line }) => line);
        } catch {
          console.error("recent activity could not be read");
        }
      let inherited: SubagentResume[] = [];
      if (continues)
        try {
          const left = unfinishedIn(this.deps.eventLog.logFile(continues));
          inherited = left.length ? resumable(left, this.deps.transcripts.briefs(continues)) : [];
        } catch {
          console.error("the earlier task's delegated agents could not be read");
        }
      // A task that continues a conversation keeps its name and, with Auto, its dot.
      const named = continues ? this.#named(continues) : undefined;
      let persona = settings.persona;
      if (settings.autoPersona && continues)
        try {
          persona = this.deps.conversations?.persona?.(continues) ?? persona;
        } catch {
          console.error("the conversation's dot could not be read");
        }
      const title = (
        origin?.success && origin.data.kind === "routine"
          ? origin.data.name
          : (named?.automatic ?? task)
      ).slice(0, 200);
      const id = this.deps.eventLog.createSession(title);
      const session = new AgentSession(
        id,
        cellId,
        task,
        this.deps.eventLog,
        autonomyOverride ?? settings.autonomy,
        new RulesStore(this.deps.home),
        {
          ...(window !== undefined ? { approvalTtlMs: window } : {}),
          ...(run?.success ? { run: run.data } : {}),
        },
      );
      session.earlier = earlier;
      session.inherited = inherited;
      session.permissionMode = () => {
        // A routine set to ask first or only read keeps its own policy whatever the chat's mode.
        if (session.run && session.run.profile !== "act_within_rules") return "custom";
        try {
          return this.deps.settings().permissionMode ?? "custom";
        } catch {
          return "custom";
        }
      };
      // Jev's answers in this task, by the question it was asked: the same action is asked once.
      const verdicts = new Map<string, boolean>();
      session.autoPermit = async (action, signal, observe) => {
        const keys = await this.deps.keyd.secrets();
        const choice = judgeChoice(this.deps.settings().purposeCheck, keys, false);
        if (choice?.kind !== "jev" || !this.deps.jev) return false;
        let evidence: { effect: "navigate" | "read"; target: string } | undefined;
        if (
          action.tool === "computer" &&
          action.operation === "click" &&
          action.actionClass === "unknown" &&
          observe &&
          rt.selection.kind === "api"
        ) {
          const role = rt.selection.roles.find((r) => r.role === "main" && r.model.vision);
          if (role && rt.brain) {
            evidence = await visualNavigation(
              observe,
              gatewayCompletion(
                () => (rt.brain ? bindingOf(role, rt.brain.surrogates) : undefined),
                () =>
                  rt.brain ? { port: rt.brain.keydPort, token: rt.brain.proxyToken } : undefined,
              ),
              AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            );
            if (!evidence) return false;
          }
        }
        const request = evidence
          ? jevNavigationRequest(session.currentPurpose, evidence)
          : action.local
            ? jevLocalChangeRequest(session.currentPurpose, action)
            : jevApprovalRequest(session.currentPurpose, action);
        const asked = JSON.stringify(request);
        const known = verdicts.get(asked);
        if (known !== undefined) return known;
        const reply = await this.deps.jev(
          choice.secretId,
          request,
          AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        );
        const fits = jevFits(reply) >= 0.9;
        verdicts.set(asked, fits);
        return fits;
      };
      if (options.research)
        session.research = new ResearchLog(
          settings.research ?? DEFAULT_RESEARCH_BUDGET,
          (type, data) => session.append(type, data),
        );
      // dot's earlier replies may repeat what a page said: they never unlock memory writes.
      if (earlier.length) session.tainted = true;
      session.recent = recent;
      session.actionLimit = settings.checkIns?.actions;
      const rt: Runtime = {
        session,
        selection,
        ...(persona ? { persona } : {}),
        limits: agentLimits(settings.checkIns),
        skills: [],
        epoch: 0,
        initialized: false,
        serial: Promise.resolve(),
        ...(idle !== undefined ? { idleMs: idle } : {}),
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
      this.#share(session, continues);
      // The desktop's browser starts afresh only for a computer no other task is using.
      const alone = !this.deps.live.busy(cellId);
      try {
        this.deps.installSession?.(session, cell, !continues);
        session.append("session.start", {
          screen: { w: 1280 * cell.scale, h: 800 * cell.scale, scale: cell.scale },
          os: "linux",
          title,
          ...(continues ? { continues } : {}),
          ...(origin?.success ? { origin: origin.data } : {}),
          ...(revises?.success ? { revises: revises.data } : {}),
          ...(session.research ? { research: session.research.budget } : {}),
        });
        session.append("message.user", { messageId: ulid(), text: task, kind: "task" });
        if (named?.user) session.append("session.title", { title: named.user, by: "user" });
        if (!origin && !continues) this.#lookFirst(rt, task, !!settings.autoPersona);
        if (earlier.length) session.taint.add("recall", "earlier conversation", earlier.join("\n"));
        if (recent.length)
          session.taint.add("memory", "recent activity", recent.map((r) => r.title).join("\n"));
        this.#safety(rt);
        this.deps.live.start(
          cellId,
          id,
          (stop) => this.#run(rt, stop),
          this.deps.prepareDesktop && alone ? (stop) => this.#prepareDesktop(rt, stop) : undefined,
        );
      } catch (error) {
        session.stop();
        await session.screensSettled().catch(() => {});
        this.sessions.delete(id);
        this.#runtime.delete(id);
        throw error;
      }
      if (!origin)
        try {
          this.deps.conversations?.adopt(id, continues ?? null);
        } catch {
          console.error("the current conversation could not be saved");
        }
      return session;
    } finally {
      admittedNext();
    }
  }
  #named(sessionId: string): ConversationNames | undefined {
    try {
      return this.deps.conversations?.names?.(sessionId);
    } catch {
      console.error("the conversation's name could not be read");
      return undefined;
    }
  }
  // A new conversation's name and, with Auto, its dot, from one quick call beside the task. The
  // name comes when it comes; the dot only counts if it comes before the agent starts.
  #lookFirst(rt: Runtime, task: string, auto: boolean): void {
    const ask = this.#quick(rt);
    if (!ask) return;
    const looked = firstLook(ask, task, auto, AbortSignal.timeout(LOOK_MS)).catch(
      (): FirstLook => ({}),
    );
    void looked.then(({ title }) => {
      if (!title) return;
      try {
        rt.session.append("session.title", { title, by: "auto" });
      } catch {
        console.error("the conversation's name could not be saved");
      }
    });
    if (!auto) return;
    const answered = new AbortController();
    const late = (this.deps.sleep ?? sleep)(DOT_WAIT_MS, answered.signal).then(
      (): FirstLook => ({}),
      (): FirstLook => ({}),
    );
    rt.choosing = Promise.race([looked, late]);
    void looked.then(() => answered.abort());
  }
  // The fast model, else the main one at its least thinking. A ChatGPT plan has none to spare: its
  // one Codex process is the task's.
  #quick(rt: Runtime): Ask | undefined {
    const { selection, session } = rt;
    if (selection.kind === "claude-code") {
      const { quick } = selection;
      const answer = this.deps.claudeCode?.answer?.(quick);
      if (!answer) return undefined;
      return async (system, prompt, signal) => {
        const reply = await answer(system, prompt, signal);
        if (!session.stopped)
          session.append("model.usage", {
            role: selection.fast ? "fast" : "main",
            route: CLAUDE_CODE,
            model: quick.model,
            inputTokens: reply.inputTokens,
            outputTokens: reply.outputTokens,
            ...(reply.speed ? { speed: reply.speed } : {}),
          });
        return reply.text;
      };
    }
    const ask = this.deps.quickModel;
    if (selection.kind !== "api" || !ask) return undefined;
    const role =
      selection.roles.find((r) => r.role === "fast") ??
      selection.roles.find((r) => r.role === "main");
    return role && ((system, prompt, signal) => ask(role, system, prompt, signal));
  }
  // The user's own dot for a task while Auto is on. Its skills and role take over when the agent
  // next starts, which is at once for an agent at work: it carries on from its saved history.
  switchPersona(id: string, persona: PersonaId): void {
    const rt = this.#runtime.get(id);
    const session = rt?.session;
    if (!rt || !session || session.stopped || rt.selection.kind === "none")
      throw new AgentError(409, "This task has ended.");
    if (
      rt.choosing ||
      session.controlHeld ||
      session.pendingAsk ||
      session.pendingApproval ||
      session.safetyPause
    )
      throw new AgentError(409, "Finish what dot is waiting on, then change its dot.");
    if ((rt.persona ?? DEFAULT_PERSONA) === persona) return;
    rt.persona = persona;
    session.append("persona.choice", { persona, by: "user" });
    if (session.generation) {
      rt.epoch += 1;
      session.retireBrain(session.generation, "restarted");
      rt.backoff?.abort();
    }
  }
  // The task's turns on the computer, which the user's control takes too; a task that continues
  // another takes up its windows.
  #share(session: AgentSession, continues?: string): void {
    const cellId = session.cellId;
    if (!this.#watched.has(cellId))
      this.#watched.set(
        cellId,
        this.deps.live.lease(cellId).subscribe(() => {
          for (const id of this.deps.live.sessionsOn(cellId)) {
            const rt = this.#runtime.get(id);
            if (rt) this.#told(rt);
          }
        }),
      );
    const computer = this.deps.computer;
    if (!computer) return;
    session.computer = {
      forUser: (signal) => computer.take(session.id, session.cellId, signal, true),
    };
    if (continues) computer.owners(session.cellId).inherit(session.id, continues);
  }
  #judge(
    rt: Runtime,
    settings: AgentSettings,
    keys: KeydRecord[] | undefined,
  ): PurposeJudge | undefined {
    if (!keys) return unreadableJudge;
    const fast = this.#fast(rt);
    const choice = judgeChoice(settings.purposeCheck, keys, !!fast);
    const jev = this.deps.jev;
    if (choice?.kind === "jev" && jev)
      return jevJudge((body, signal) => jev(choice.secretId, body, signal));
    if (choice?.kind !== "model" || !fast) return undefined;
    return modelJudge(fast.ask);
  }
  // The task's fast model, asked one question with no tools: on the plan through Claude Code, which
  // counts its usage in the task, or through the task's own key layer, which counts its cost.
  #fast(rt: Runtime): FastModel | undefined {
    const planFast = rt.selection.kind === "claude-code" ? rt.selection.fast : undefined;
    const answer = planFast && this.deps.claudeCode?.answer?.(planFast);
    if (planFast && answer)
      return {
        provider: CLAUDE_CODE,
        model: planFast.model,
        ready: () => true,
        ask: async (system, prompt, signal) => {
          const reply = await answer(system, prompt, signal);
          if (!rt.session.stopped)
            rt.session.append("model.usage", {
              role: "fast",
              route: CLAUDE_CODE,
              model: planFast.model,
              inputTokens: reply.inputTokens,
              outputTokens: reply.outputTokens,
              ...(reply.speed ? { speed: reply.speed } : {}),
            });
          return reply.text;
        },
      };
    const fast =
      rt.selection.kind === "api"
        ? rt.selection.roles.find((role) => role.role === "fast")
        : undefined;
    if (!fast) return undefined;
    return {
      provider: fast.providerId,
      model: fast.model.id,
      ready: () => !!rt.brain,
      ask: gatewayCompletion(
        () => (rt.brain ? bindingOf(fast, rt.brain.surrogates) : undefined),
        () => (rt.brain ? { port: rt.brain.keydPort, token: rt.brain.proxyToken } : undefined),
      ),
    };
  }
  // A side question about a task, answered by the fast model with no tools. The task never hears
  // of it: nothing of the question or the answer reaches its transcript or its log. With no task
  // at work, a fast model on the Claude Code plan answers from the saved settings; one on an API
  // key needs the task's key layer, which only a running task has.
  async sideAnswer(
    sessionId: string,
    question: string,
    signal: AbortSignal,
  ): Promise<{ answer: string; provider: string; model: string }> {
    let file: string;
    try {
      file = this.deps.eventLog.logFile(sessionId);
    } catch {
      throw new AgentError(404, "no such task");
    }
    if (!existsSync(file)) throw new AgentError(404, "no such task");
    const rt = this.#runtime.get(sessionId);
    const fast = (rt && !rt.session.stopped ? this.#fast(rt) : undefined) ?? this.#savedFast();
    if (!fast.ready()) throw new SideQuestionError(409, "fast-model-not-running");
    const { system, prompt } = sideQuestionPrompt(sideQuestionEvents(file), question);
    let text: string;
    try {
      text = await fast.ask(system, prompt, signal);
    } catch {
      signal.throwIfAborted();
      throw new SideQuestionError(502, "no-answer");
    }
    return { answer: sideAnswerText(text), provider: fast.provider, model: fast.model };
  }
  #savedFast(): FastModel {
    const fast = activeRoles(this.deps.settings()).fast;
    if (!fast || fast.provider === CHATGPT) throw new SideQuestionError(409, "no-fast-model");
    const saved = { provider: fast.provider, model: fast.model };
    if (fast.provider !== CLAUDE_CODE)
      return { ...saved, ready: () => false, ask: () => Promise.reject(new Error("no brain")) };
    const answer = this.deps.claudeCode?.answer?.({
      model: fast.model,
      ...(fast.options ? { options: fast.options } : {}),
    });
    if (!answer) throw new SideQuestionError(409, "no-fast-model");
    return {
      ...saved,
      ready: () => true,
      ask: async (system, prompt, signal) => (await answer(system, prompt, signal)).text,
    };
  }
  // A parked (approval, question, takeover, budget) or idle task ends here without the kill
  // switch: no revoke and no freeze. The runner's own finally block appends session.end.
  end(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.stopped) return false;
    session.cancel();
    return true;
  }
  async stopRun(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return this.#terminal.has(id);
    if (!session.stopped) session.cancel();
    // Do not acknowledge Stop until the old run has retired and released ownership.
    await this.deps.live.settled(id);
    return true;
  }
  // Ends a finished task that waits for a follow-up, so the next message starts a new task in
  // whichever conversation is current. A task still at work is left alone and refused.
  // A selected session scopes the release; null means an empty conversation. Unrelated
  // computers keep their tasks and manual control. Omission retains the all-task lifecycle API.
  async release(signal?: AbortSignal, sessionId?: string | null): Promise<void> {
    if (this.#starting.size) throw new AgentError(409, "A task is starting.");
    const live = [...this.#runtime.values()].filter(
      (rt) => !rt.session.stopped && (sessionId === undefined || rt.session.id === sessionId),
    );
    if (live.some((rt) => rt.selection.kind === "none" && rt.session.controlHeld))
      throw new AgentError(409, "Hand back the computer first.");
    // The final result is durable before Docker/native retirement finishes. Allow a New
    // conversation request in that interval to wait briefly for retirement instead of
    // telling the user to stop work that has already delivered its result.
    await Promise.all(
      live.map(async (rt) => {
        const s = rt.session;
        if (
          rt.completion &&
          s.status === "running" &&
          !s.controlHeld &&
          !s.pendingAsk &&
          !s.pendingApproval &&
          !s.safetyPause &&
          !rt.pause
        )
          await s.waitForIdle(10_000, signal);
      }),
    );
    const waiting = live.filter((rt) => !rt.session.stopped && rt.selection.kind !== "none");
    if (
      waiting.some(
        (rt) =>
          !recoverable(rt.session) &&
          (rt.session.status !== "idle" || rt.session.controlHeld || !rt.idleWait),
      )
    )
      throw new AgentError(409, "Finish or stop the current task first.");
    for (const rt of waiting) {
      rt.released = true;
      if (rt.idleWait) rt.idleWait.abort();
      else rt.session.cancel();
    }
    const settled = Promise.all(waiting.map((rt) => this.deps.live.settled(rt.session.id)));
    await (signal ? abortable(settled, signal) : settled);
  }
  // Another task's switch to the web browser ends the finished task still holding it, as a sign-in
  // does; false when that task is at work or waiting for the user.
  async makeWay(sessionId: string, signal: AbortSignal): Promise<boolean> {
    try {
      await this.release(signal, sessionId);
      return true;
    } catch (error) {
      if (error instanceof AgentError) return false;
      throw error;
    }
  }
  // Settings > Accounts: the web browser opens the site's sign-in page and the user takes it there,
  // where the sign-in is kept. Their own hold of the computer gives way to this one, and a finished
  // task waiting for a follow-up ends; a task at work is left alone.
  async signIn(
    cellId: string,
    site: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<TakeComputerReply> {
    if (!ULID_PATTERN.test(cellId)) throw new AgentError(400, "invalid computer id");
    this.#ready(cellId);
    await this.#browserStarted(cellId, signal);
    const live = this.#userHold(cellId);
    if (live) {
      const requestId = live.pendingTakeover;
      if (requestId && !(await live.handback(requestId, undefined, signal)))
        throw new AgentError(409, "Hand back the computer, then sign in.");
    }
    // A finished task still showing the web browser makes way; one at work there is left alone.
    const browsing = this.deps.live.browserHolder(cellId);
    if (browsing && browsing !== live?.id) await this.release(signal, browsing);
    return this.hold(cellId, signal, { url, title: `Sign in to ${site}` });
  }
  // The web browser starts before the user's own hold gives way, so one that can't start leaves
  // them in control where they are. A start that runs long goes on by itself.
  async #browserStarted(cellId: string, signal?: AbortSignal): Promise<void> {
    const starting = this.deps.startBrowser?.(cellId);
    if (!starting) return;
    const timeout = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => timeout.resolve(false), SIGN_IN_BROWSER_WAIT_MS);
    let started: boolean;
    try {
      const race = Promise.race([
        starting.then(
          () => true,
          () => false,
        ),
        timeout.promise,
      ]);
      started = await (signal ? abortable(race, signal) : race);
    } finally {
      clearTimeout(timer);
    }
    if (!started) throw new AgentError(503, BROWSER_UNAVAILABLE);
  }
  // The user's own session holds the computer, in the current conversation, until they hand it
  // back; every task sharing the computer waits meanwhile. Given a page, the hold first opens it
  // in the web browser, and the user takes the computer there.
  async hold(
    cellId: string,
    signal?: AbortSignal,
    open?: { url: string; title: string },
  ): Promise<TakeComputerReply> {
    if (!ULID_PATTERN.test(cellId)) throw new AgentError(400, "invalid computer id");
    this.#ready(cellId);
    if (this.#starting.has(cellId)) throw new AgentError(409, "a task is starting");
    const current = this.#userHold(cellId);
    if (current) {
      if (current.controlHeld) {
        if (open) throw new AgentError(409, "You already have the computer.");
        return { sessionId: current.id, requestId: current.takeControl() };
      }
      // A hold the user handed back is ending: the new one follows it.
      const settled = this.deps.live.settled(current.id);
      await (signal ? abortable(settled, signal) : settled);
    }
    const cell = this.#ready(cellId);
    if (this.#starting.has(cellId) || this.#userHold(cellId))
      throw new AgentError(409, "the computer is changing hands");
    let continues: string | undefined;
    try {
      continues = this.deps.conversations?.current() ?? undefined;
    } catch {
      console.error("the earlier conversation could not be read");
      continues = undefined;
    }
    // The user's own time is called what the conversation is, in the app; Replay keeps its own name.
    const named = continues ? this.#named(continues) : undefined;
    const title = named?.user ?? named?.automatic ?? undefined;
    const id = this.deps.eventLog.createSession(open?.title ?? HOLD_TITLE);
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
    this.#share(session);
    let requestId: string | Promise<string>;
    try {
      this.deps.installSession?.(session, cell);
      session.append("session.start", {
        screen: { w: 1280 * cell.scale, h: 800 * cell.scale, scale: cell.scale },
        os: "linux",
        ...(title ? { title } : {}),
        ...(continues ? { continues } : {}),
      });
      session.setStatus("idle");
      if (open) requestId = this.#openForUser(rt, open.url);
      else {
        // Before its run starts, which ends once the user no longer holds the computer.
        requestId = session.takeControl();
        this.deps.live.start(cellId, id, (stop) => this.#run(rt, stop));
      }
    } catch (error) {
      session.stop();
      await session.screensSettled().catch(() => {});
      this.sessions.delete(id);
      this.#runtime.delete(id);
      throw error;
    }
    // A page that can't open ends the hold; its run records the end.
    const taken = await Promise.resolve(requestId).catch(() => {
      throw new AgentError(503, BROWSER_UNAVAILABLE);
    });
    try {
      this.deps.conversations?.adopt(id);
    } catch {
      console.error("the current conversation could not be saved");
    }
    return { sessionId: id, requestId: taken };
  }
  // The hold's page opens once its session is live and recorded, and then the user takes it.
  #openForUser(rt: Runtime, url: string): Promise<string> {
    const { session } = rt;
    const opened = Promise.withResolvers<string>();
    this.deps.live.start(session.cellId, session.id, async (stop) => {
      try {
        const screens = session.screens;
        if (!screens) throw new Error("the web browser is unavailable");
        await screens.openForUser(url, {
          sessionId: session.id,
          generation: 1,
          signal: AbortSignal.any([session.abort.signal, stop]),
          check: () => {
            if (session.stopped) throw new SessionStoppedError();
          },
        });
        opened.resolve(session.takeControl());
      } catch (error) {
        // With nothing taken, the run ends the hold as an ordinary finish, leaving the computer on.
        opened.reject(error);
      }
      return this.#run(rt, stop);
    });
    return opened.promise;
  }
  #userHold(cellId: string): AgentSession | undefined {
    for (const id of this.deps.live.sessionsOn(cellId)) {
      const session = this.sessions.get(id);
      if (session && !session.stopped && this.holds(id)) return session;
    }
    return undefined;
  }
  // A live task as the conversation list shows it.
  liveStatus(id: string): ConversationLive | undefined {
    const rt = this.#runtime.get(id);
    if (!rt || rt.session.stopped || rt.selection.kind === "none") return undefined;
    return this.#told(rt);
  }
  #told(rt: Runtime): ConversationLive | undefined {
    const { session } = rt;
    if (session.stopped || rt.selection.kind === "none") return undefined;
    const lease = this.deps.live.lease(session.cellId);
    const cell = this.deps.cell(session.cellId);
    const state: ConversationLive["state"] =
      session.safetyPause || rt.pause || session.status === "paused" || cell?.paused
        ? "paused"
        : session.pendingApproval ||
            session.pendingAsk ||
            session.controlHeld ||
            session.connections.pending
          ? "needs-you"
          : lease.waiting().includes(session.id)
            ? "waiting-for-computer"
            : session.status === "idle"
              ? "idle"
              : "working";
    const onScreen = lease.holder === session.id;
    const activity = state === "idle" ? undefined : rt.activity;
    const before = rt.live;
    if (before?.state === state && before.onScreen === onScreen && before.activity === activity)
      return before;
    rt.live = {
      state,
      since: before?.state === state ? before.since : new Date().toISOString(),
      onScreen,
      ...(activity ? { activity } : {}),
    };
    try {
      this.deps.liveChanged?.(session.id, rt.live);
    } catch {
      console.error("a live status could not be told");
    }
    return rt.live;
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
          this.deps.live.cellOf(rt.session.id) !== rt.session.cellId ||
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
      ...(native(rt.selection)
        ? {
            native: {
              pause: (
                pause: Pick<import("@localdot/protocol").PauseSnapshot, "requestId" | "revision">,
              ) => {
                const driver = this.#nativeDriver(rt);
                if (!driver?.pauseAtBoundary)
                  throw new Error("native Pause receipt is unavailable");
                return driver.pauseAtBoundary(rt.session, pause);
              },
              resume: (
                pause: Pick<import("@localdot/protocol").PauseSnapshot, "requestId" | "revision">,
                receipt: import("./codex/native-pause.ts").NativePauseReceipt,
              ) => {
                const driver = this.#nativeDriver(rt);
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
  #nativeDriver(rt: Runtime) {
    return rt.selection.kind === "chatgpt"
      ? this.deps.codex?.driver
      : rt.selection.kind === "claude-code"
        ? this.deps.claudeCode?.driver
        : undefined;
  }
  isChatgpt(id: string): boolean {
    return this.#runtime.get(id)?.selection.kind === "chatgpt";
  }
  skillsOf(id: string): SkillSummary[] {
    return structuredClone(this.#runtime.get(id)?.skills ?? []);
  }
  // The instructions of the dot the task started with; none for the everyday dot.
  roleOf(id: string): string | undefined {
    return personaOf(this.#runtime.get(id)?.persona).guidance || undefined;
  }
  codexDenyReadOf(id: string): readonly string[] {
    const selection = this.#runtime.get(id)?.selection;
    return selection?.kind === "chatgpt" ? [...selection.denyRead] : [];
  }
  selectionOf(id: string) {
    const selection = this.#runtime.get(id)?.selection;
    if (!selection || selection.kind === "none") return undefined;
    return selection.kind === "chatgpt" || selection.kind === "claude-code"
      ? {
          kind: selection.kind,
          model: selection.model,
          ...(selection.options ? { options: selection.options } : {}),
        }
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
    if (rt.selection.kind === "claude-code")
      throw new AgentError(409, "A Claude Code task uses your plan's limits, not a budget.");
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
        // Fence before yielding.
        if (session.generation) session.retireBrain(session.generation, "restarted");
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
      if (now.online && !vaultLocked(now) && session.keysLocked) {
        // dot hears the keys are open; a model that stopped on its own key also resumes.
        session.keysUnlocked();
        if (rt.pause === "keys" && session.status === "paused" && !session.controlHeld) {
          rt.pause = undefined;
          session.post("resume", "");
        }
      }
    }
    this.#changed();
  }
  // A service restart retires task execution, but does not retire the computer identity.
  // Only an unconfirmed stop needs the durable failure fence.
  async stopForShutdown(session: AgentSession): Promise<void> {
    session.cancel("restarted");
    try {
      const outcome = await this.deps.stopSession(session.id);
      if (outcome && (!outcome.revoked || !(outcome.paused || (outcome.closed && outcome.stopped))))
        throw new CleanupUncertain("shutdown stop could not be confirmed");
      await this.deps.live.settled(session.id);
      await session.toolsSettled();
      await session.screensSettled();
    } catch (error) {
      await this.contain(session, "shutdown_cleanup_uncertain").catch(() => {});
      throw error;
    }
  }
  // Handler uncertainty cannot skip containment merely because it already fenced the session.
  contain(session: AgentSession, reason: string): Promise<void> {
    const rt = this.#runtime.get(session.id);
    session.stop();
    this.#blockedCells.add(session.cellId);
    if (!this.deps.fences?.record(session.cellId))
      console.error(
        `computer recovery required: ${session.cellId}, task ${session.id} (${/^[a-z_]{1,64}$/.test(reason) ? reason : "cleanup_uncertain"})`,
      );
    this.deps.fences?.capture(
      session.cellId,
      session.id,
      rt && native(rt.selection) ? "native" : "api",
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
        !this.deps.live.busy(cellId) &&
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
        !this.deps.live.busy(cellId) &&
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
      this.deps.fences.capture(cellId, rt.session.id, native(rt.selection) ? "native" : "api");
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
        this.deps.live.busy(cellId) ||
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
      for (const unwatch of this.#watched.values()) unwatch();
      this.#watched.clear();
      for (const rt of this.#runtime.values()) {
        rt.session.cancel("restarted");
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
      // A task that starts meanwhile acts only once the desktop's browser has started afresh.
      const turn = await this.deps.live
        .lease(session.cellId)
        .acquire(session.id, { signal: session.abort.signal });
      try {
        await this.deps.prepareDesktop?.(session);
      } finally {
        turn.release();
      }
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
      if (rt.choosing) {
        const pick = await abortable(rt.choosing, session.abort.signal);
        rt.choosing = undefined;
        if (pick.persona) rt.persona = pick.persona;
        session.append(
          "persona.choice",
          pick.persona
            ? { persona: pick.persona, by: "auto", ...(pick.reason ? { reason: pick.reason } : {}) }
            : { persona: rt.persona ?? DEFAULT_PERSONA, by: "default" },
        );
      }
      let dressed = rt.persona;
      let skills = await this.deps.installSkills(session.cellId, session.abort.signal, dressed);
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
        if (rt.persona !== dressed) {
          dressed = rt.persona;
          skills = await this.deps.installSkills(session.cellId, session.abort.signal, dressed);
          rt.skills = structuredClone(skills);
        }
        session.connectors = this.deps.connectors?.() ?? NO_CONNECTORS;
        const epoch = rt.epoch;
        let code: number | undefined;
        rt.completion = undefined;
        try {
          code =
            rt.selection.kind === "chatgpt"
              ? await this.deps.codex?.driver.run(session, {
                  model: rt.selection.model,
                  options: rt.selection.options,
                  serviceTier: rt.selection.serviceTier,
                  resume,
                })
              : rt.selection.kind === "claude-code"
                ? await this.deps.claudeCode?.driver.run(session, {
                    model: rt.selection.model,
                    options: rt.selection.options,
                    resume,
                  })
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
        if (code === BRAIN_GAVE_UP && rt.failure) {
          reason = "error";
          const why = `${rt.failure.reason ?? "The task failed."}${rt.failure.detail ? ` ${rt.failure.detail}` : ""}`;
          session.append("message.assistant", {
            messageId: ulid(),
            text: `I couldn't continue: ${why}${/[.!?]$/.test(why) ? "" : "."} Check Settings or choose another model, then send your message again.`,
          });
          break;
        }
        if (code === BRAIN_DONE || code === BRAIN_GAVE_UP) {
          crashes = 0;
          // Retiring an idle caller is not proof the task finished. Preserve its latest
          // outcome through idle expiry/release, and reset it if a follow-up later finishes.
          const complete =
            code === BRAIN_DONE && !session.actionLimitReached && rt.completion !== "blocked";
          reason = complete ? "done" : "stopped";
          session.append(
            "agent.state",
            session.actionLimitReached
              ? { state: "idle", reason: STALL.actionLimit }
              : rt.completion === "blocked"
                ? { state: "idle", reason: "blocked" }
                : complete
                  ? { state: "done" }
                  : { state: "idle", reason: "gave up" },
          );
          session.setStatus("idle");
          const idleWait = new AbortController();
          rt.idleWait = idleWait;
          try {
            const idleMs = rt.idleMs ?? this.deps.idleMs ?? IDLE_MS;
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
                  : rt.selection.kind === "claude-code"
                    ? "Claude Code kept stopping."
                    : "the brain kept crashing",
            });
            break;
          }
          session.append("agent.state", {
            state: "error",
            reason:
              rt.selection.kind === "chatgpt"
                ? `Codex stopped (exit ${code ?? "unknown"}); restarting`
                : rt.selection.kind === "claude-code"
                  ? "Claude Code stopped; restarting from saved history"
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
      let doubt = false;
      if (rt.selection.kind === "chatgpt") {
        try {
          await this.deps.codex?.ended?.(session.id);
        } catch {
          reason = "error";
          doubt = true;
          this.#blockedCells.add(session.cellId);
          this.deps.fences?.capture(session.cellId, session.id, "native");
        }
      }
      if (
        native(rt.selection) &&
        this.#nativeDriver(rt)?.retirementConfirmed?.(session.id) === true
      )
        this.deps.fences?.confirmNativeRetirement(session.cellId, session.id);
      if (session.stopped && reason === "done") reason = "stopped";
      try {
        if (reason === "done") {
          if (!(await session.finish())) reason = "stopped";
        } else {
          // A task that ended on its own, even in an error, leaves the computer on; only doubt
          // about its cleanup stops the computer. Its delegated agents may resume in a later task.
          if (doubt) session.stop();
          else session.cancel("error");
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
      if (rt.live)
        try {
          this.deps.liveChanged?.(session.id, undefined);
        } catch {
          console.error("a live status could not be told");
        }
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
        const memory = this.deps.memory.bootMemory(session.task, models.main.contextTokens);
        taintMemory(session.taint, memory);
        let subagents: SubagentResume[] = [];
        try {
          subagents = session.unfinishedAgents(this.deps.transcripts);
        } catch {
          console.error("the task's delegated agents could not be read");
        }
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
          ...(session.recent.length ? { recent: [...session.recent] } : {}),
          ...(session.run ? { run: session.run } : {}),
          ...(session.connectors.specs.length ? { connectors: [...session.connectors.specs] } : {}),
          ...(session.research ? { research: session.research.budget } : {}),
          ...(this.roleOf(session.id) ? { role: this.roleOf(session.id) } : {}),
          ...(subagents.length ? { subagents } : {}),
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
