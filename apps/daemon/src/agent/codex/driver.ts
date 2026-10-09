import { setTimeout as delay } from "node:timers/promises";
import {
  AccountRead,
  type ApprovalContext,
  type ApprovalIdentity,
  type AppServerRpc,
  type BlockedStep,
  CodexLaunchError,
  type CodexTurnEpoch,
  type RpcRequestOptions,
  ThreadStartResult,
  Turn,
  threadStartParams,
  turnOutcome,
} from "@localdot/codex-harness";
import {
  earlierRecord,
  type InboxItem,
  type PauseSnapshot,
  type ScreenName,
  type ToolResult,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import { z } from "zod";
import { type Redactor, redactor } from "../redact.ts";
import type { AgentSession, BrainGeneration } from "../session.ts";
import type { TranscriptStore } from "../transcript.ts";
import { CodexEventMapper, type Violation } from "./events.ts";
import type {
  McpCallContext,
  McpEndpoint,
  McpEndpointInput,
  McpPauseReceipt,
} from "./mcp-endpoint.ts";
import type { NativePauseReceipt } from "./native-pause.ts";

export const CODEX_DONE = 0;
export const CODEX_GAVE_UP = 3;
export const CODEX_CRASHED = 70;
const NUDGE =
  "If the task is finished, call the localdot done tool with a summary. If you need the user, call ask_user.";
const FRESH =
  "The previous action was canceled because its screenshot was stale. Use this fresh screenshot to decide what to do next; do not apply the canceled action automatically.";
const SUB_AGENT =
  "Sub-agents are not available here. Continue the task yourself with the localdot tools.";
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PROMPT_BYTES = 256 * 1024;
const TurnStartResult = z.looseObject({ turn: Turn });
const opaqueObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Codex response.");
  return value as Record<string, unknown>;
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function readonlyAwait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("The Codex operation was retired."));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
    if (signal.aborted) abort();
  });
}
function retirementDeadline(work: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodexCleanupError()), 2000);
    work
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
      .catch(() => {});
  });
}
export class CodexCleanupError extends Error {
  constructor() {
    super("The ChatGPT task could not be safely retired.");
    this.name = "CodexCleanupError";
  }
}
export interface TaskConnection {
  readonly rpc: Pick<AppServerRpc, "request" | "notify">;
  readonly workDir: string;
  readonly exited: Promise<unknown>;
  readonly closed: Promise<void>;
  readonly failure: Promise<CodexLaunchError>;
  stop(): Promise<void>;
}
export interface TaskLaunch {
  readonly sessionId: string;
  readonly endpoint: McpEndpoint;
  readonly signal: AbortSignal;
  readonly onRegister: (connection: TaskConnection) => void;
  readonly isCurrent: () => boolean;
  readonly onFence: () => void;
  readonly approvalContext: () => ApprovalContext;
  readonly onBlocked: (step: BlockedStep) => void;
  readonly onNotification: (
    method: string,
    params: unknown,
    context: { signal: AbortSignal },
  ) => void;
  readonly onFailure: (cause: CodexLaunchError) => void;
  readonly interruptTurn: () => { threadId: string; turnId: string } | undefined;
}
export interface CodexDriverLease {
  readonly generation: number;
  readonly signal: AbortSignal;
  launch(input: TaskLaunch): Promise<TaskConnection>;
  release(): Promise<void>;
}
export type DriverEndpointInput = Pick<
  McpEndpointInput,
  | "session"
  | "generation"
  | "authGeneration"
  | "currentAuthGeneration"
  | "authSignal"
  | "signal"
  | "onResult"
  | "onRetire"
>;
export interface CodexDriverDeps {
  readonly auth: {
    readonly authGeneration: number;
    canResume?(generation: number): boolean;
    acquireTask(sessionId: string, signal: AbortSignal): Promise<CodexDriverLease>;
    markSignedOut(generation: number): void;
  };
  readonly openEndpoint: (input: DriverEndpointInput) => Promise<McpEndpoint>;
  readonly observe: (
    session: AgentSession,
    generation: BrainGeneration,
    signal: AbortSignal,
  ) => Promise<{ frameId: string; full: true; png: Buffer; screen?: ScreenName }>;
  readonly transcripts: TranscriptStore;
  readonly instructions: (session: AgentSession) => string;
  readonly redactorFor?: (session: AgentSession) => Redactor;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly heartbeatMs?: number;
  // Daemon-owned mutation cursor preserves an explicit Resume posted during cleanup.
  readonly waitForAuthResume?: (session: AgentSession) => Promise<void>;
}
type CycleResult =
  | { kind: "completed"; pending: boolean }
  | {
      kind:
        | "done"
        | "retired"
        | "control"
        | "auth"
        | "stale"
        | "input"
        | "crashed"
        | "signed_out"
        | "plan_limit"
        | "safety";
    }
  | { kind: "violation"; what: Violation }
  | { kind: "retry" | "failed"; message: string };
interface ActiveCycle {
  finish(result: CycleResult): void;
  fence(): void;
  pauseAtBoundary(
    pause: Pick<PauseSnapshot, "requestId" | "revision">,
  ): Promise<{ generationId: number; completedCalls: number }>;
}
interface DriverOwner {
  readonly session: AgentSession;
  admission: Promise<void>;
  lease?: CodexDriverLease;
  active?: ActiveCycle;
}

// Until Tasks13/14 prove a no-late-request boundary, every explicit turn uses a fresh process,
// endpoint, shared BrainGeneration and frozen image basis. Deliberate retirement is not a crash.
export class CodexDriver {
  readonly #deps: CodexDriverDeps;
  readonly #running = new Set<string>();
  readonly #blocked = new Set<string>();
  readonly #owners = new Map<string, DriverOwner>();
  readonly #pauseReceipts = new WeakMap<AgentSession, NativePauseReceipt>();
  readonly #resumeNotes = new WeakMap<AgentSession, string>();
  constructor(deps: CodexDriverDeps) {
    this.#deps = Object.freeze({ ...deps });
  }
  retirementConfirmed(sessionId: string): boolean {
    return (
      !this.#running.has(sessionId) && !this.#owners.has(sessionId) && !this.#blocked.has(sessionId)
    );
  }
  async pauseAtBoundary(
    session: AgentSession,
    pause: Pick<PauseSnapshot, "requestId" | "revision">,
  ): Promise<NativePauseReceipt> {
    const authGeneration = this.#deps.auth.authGeneration;
    const check = () => {
      if (
        session.stopped ||
        session.controlHeld ||
        this.#blocked.has(session.id) ||
        session.safetyPause?.requestId !== pause.requestId ||
        session.safetyPause.revision !== pause.revision ||
        this.#deps.auth.authGeneration !== authGeneration
      )
        throw new CodexCleanupError();
    };
    check();
    const previous = this.#pauseReceipts.get(session);
    if (previous) {
      if (
        previous.requestId !== pause.requestId ||
        previous.revision !== pause.revision ||
        previous.authGeneration !== authGeneration
      )
        throw new CodexCleanupError();
      return previous;
    }
    const owner = this.#owners.get(session.id);
    if (owner && owner.session !== session) throw new CodexCleanupError();
    if (owner) await readonlyAwait(owner.admission, session.abort.signal);
    check();
    const facts = owner?.active ? await owner.active.pauseAtBoundary(pause) : undefined;
    check();
    // No native credential owner or admitted generation may remain after the physical retirement receipt.
    if (owner?.lease || owner?.active || session.generation) throw new CodexCleanupError();
    const receipt: NativePauseReceipt = Object.freeze({
      sessionId: session.id,
      requestId: pause.requestId,
      revision: pause.revision,
      authGeneration,
      generationId: facts?.generationId ?? null,
      turnRetired: true,
      callsSettled: true,
      resultOwnershipConfirmed: true,
      completedCalls: facts?.completedCalls ?? 0,
    });
    this.#pauseReceipts.set(session, receipt);
    return receipt;
  }
  async resumeAtBoundary(
    session: AgentSession,
    pause: Pick<PauseSnapshot, "requestId" | "revision">,
    receipt: NativePauseReceipt,
  ): Promise<void> {
    const owner = this.#owners.get(session.id);
    if (
      this.#pauseReceipts.get(session) !== receipt ||
      receipt.sessionId !== session.id ||
      receipt.requestId !== pause.requestId ||
      receipt.revision !== pause.revision ||
      session.stopped ||
      session.controlHeld ||
      session.safetyPause?.phase !== "resuming" ||
      !session.safetyPause.atStepBoundary ||
      session.safetyPause.requestId !== pause.requestId ||
      session.safetyPause.revision !== pause.revision ||
      this.#deps.auth.authGeneration !== receipt.authGeneration ||
      this.#deps.auth.canResume?.(receipt.authGeneration) !== true ||
      this.#blocked.has(session.id) ||
      owner?.active ||
      owner?.lease ||
      session.generation
    )
      throw new CodexCleanupError();
    this.#pauseReceipts.delete(session);
    this.#resumeNotes.set(
      session,
      `The previous native turn and all its calls were retired before Pause. ${receipt.completedCalls} call results were confirmed under that owner. Do not replay any previous tool call. Choose fresh work from the current full screenshot.`,
    );
  }
  async run(session: AgentSession, input: { model: string; resume: boolean }): Promise<number> {
    if (this.#blocked.has(session.id)) throw new CodexCleanupError();
    if (this.#running.has(session.id)) throw new Error("The ChatGPT task is already running.");
    if (session.stopped) return CODEX_DONE;
    if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 128) {
      this.#state(session, "error", "The ChatGPT model selection is invalid.");
      return CODEX_GAVE_UP;
    }
    this.#running.add(session.id);
    const owner: DriverOwner = { session, admission: Promise.resolve() };
    this.#owners.set(session.id, owner);
    let admission: ReturnType<typeof deferred<void>> | undefined;
    const d = this.#deps,
      redact = d.redactorFor?.(session) ?? redactor([]);
    let active: ActiveCycle | undefined,
      recap = input.resume,
      next = "",
      nudged = false,
      retries = 0,
      subAgents = 0;
    const stopped = () => active?.finish({ kind: "retired" });
    session.abort.signal.addEventListener("abort", stopped, { once: true });
    try {
      while (!session.stopped) {
        await session.waitForSafety();
        await session.waitForControl();
        await session.waitForTools();
        await this.#authResume(session);
        let lease: CodexDriverLease;
        admission = deferred<void>();
        owner.admission = admission.promise;
        const acquiring = d.auth.acquireTask(session.id, session.abort.signal);
        try {
          lease = await readonlyAwait(acquiring, session.abort.signal);
        } catch (cause) {
          if (!session.stopped) throw cause;
          void acquiring
            .then(
              (late) => this.#release(session, late),
              () => {},
            )
            .catch(() => {
              this.#blocked.add(session.id);
            });
          return CODEX_DONE;
        }
        owner.lease = lease;
        if (session.stopped) {
          await this.#release(session, lease);
          owner.lease = undefined;
          admission.resolve();
          return CODEX_DONE;
        }
        try {
          await session.waitForControl();
          await session.waitForTools();
          await this.#authResume(session);
          if (session.safetyPause) {
            await this.#release(session, lease);
            owner.lease = undefined;
            admission.resolve();
            await session.waitForSafety();
            continue;
          }
        } catch (cause) {
          await this.#release(session, lease);
          owner.lease = undefined;
          admission.resolve();
          throw cause;
        }
        if (lease.signal.aborted || lease.generation !== d.auth.authGeneration) {
          await this.#release(session, lease);
          owner.lease = undefined;
          admission.resolve();
          await this.#pause(session, "chatgpt account changed");
          recap = true;
          continue;
        }
        let generation: BrainGeneration;
        try {
          generation = session.beginBrain();
        } catch (cause) {
          await this.#release(session, lease);
          throw cause;
        }
        session.setStatus("running");
        const result = await this.#cycle(
          session,
          generation,
          lease,
          input.model,
          recap,
          next,
          redact,
          (cycle) => {
            active = cycle;
            owner.active = cycle;
            admission?.resolve();
          },
        );
        active = undefined;
        owner.active = undefined;
        owner.lease = undefined;
        admission.resolve();
        recap = true;
        if (result.kind === "safety") {
          await session.waitForSafety();
          next = "Continue after explicit safety Resume. Do not replay a completed call.";
          continue;
        }
        if (session.stopped || result.kind === "done" || result.kind === "retired")
          return CODEX_DONE;
        if (result.kind === "crashed") return CODEX_CRASHED;
        if (result.kind === "control") {
          await session.waitForControl();
          // Takeover now fences immediately. An account change while that retired cycle
          // waits for hand-back still requires Resume under the replacement credentials.
          if (!session.stopped && lease.generation !== d.auth.authGeneration) {
            await this.#pause(session, "chatgpt account changed");
            retries = 0;
          }
          next = "Continue after the user's hand-back.";
          continue;
        }
        if (
          result.kind === "auth" ||
          result.kind === "signed_out" ||
          result.kind === "plan_limit"
        ) {
          await this.#pause(
            session,
            result.kind === "auth"
              ? "chatgpt account changed"
              : result.kind === "signed_out"
                ? "chatgpt sign-in expired"
                : "chatgpt plan limit reached",
          );
          next = "Continue.";
          retries = 0;
          continue;
        }
        if (result.kind === "stale") {
          next = FRESH;
          continue;
        }
        if (result.kind === "input") {
          next =
            "Continue with the user's saved follow-up. The previous steering request was not confirmed.";
          continue;
        }
        if (result.kind === "violation") {
          if (result.what === "sub_agent" && ++subAgents < 3) {
            next = SUB_AGENT;
            continue;
          }
          const reason =
            result.what === "command"
              ? "Codex ran a command of its own; localDot stopped the task"
              : result.what === "file_applied"
                ? "Codex changed a file itself; localDot stopped the task"
                : result.what === "sub_agent"
                  ? "Codex kept starting sub-agents; localDot stopped the task"
                  : "Codex used a tool that is not localDot's; localDot stopped the task";
          this.#state(session, "error", reason);
          return CODEX_GAVE_UP;
        }
        if (result.kind === "retry") {
          if (retries >= 3) {
            await this.#pause(session, "model unavailable");
            next = "Continue.";
            retries = 0;
            continue;
          }
          const waitMs = 1000 * 2 ** retries;
          retries++;
          if (!session.controlHeld)
            session.append("model.retry", {
              role: "main",
              attempt: retries,
              waitMs,
              message: result.message,
            });
          await (d.sleep ?? ((ms, signal) => delay(ms, undefined, { signal })))(
            waitMs,
            session.abort.signal,
          );
          next = "Continue.";
          continue;
        }
        if (result.kind === "failed") {
          this.#state(session, "error", result.message);
          return CODEX_GAVE_UP;
        }
        retries = 0;
        if (result.kind === "completed" && result.pending) {
          next = "Continue with the user's follow-up.";
          nudged = false;
          continue;
        }
        if (!nudged) {
          next = NUDGE;
          nudged = true;
          continue;
        }
        this.#state(session, "idle", "no result");
        return CODEX_GAVE_UP;
      }
      return CODEX_DONE;
    } catch (cause) {
      if (cause instanceof CodexCleanupError) {
        this.#blocked.add(session.id);
        throw cause;
      }
      if (session.stopped) return CODEX_DONE;
      this.#state(session, "error", "The ChatGPT task could not continue.");
      return CODEX_GAVE_UP;
    } finally {
      active?.fence();
      session.abort.signal.removeEventListener("abort", stopped);
      admission?.resolve();
      this.#owners.delete(session.id);
      this.#running.delete(session.id);
    }
  }
  #state(session: AgentSession, state: "paused" | "idle" | "error", reason: string): void {
    if (session.stopped || session.controlHeld) return;
    if (state !== "error") session.setStatus(state);
    session.append("agent.state", { state, reason });
  }
  async #release(session: AgentSession, lease: CodexDriverLease): Promise<void> {
    try {
      await retirementDeadline(lease.release());
    } catch {
      this.#blocked.add(session.id);
      throw new CodexCleanupError();
    }
  }
  async #authResume(session: AgentSession): Promise<void> {
    const waiting = this.#deps.waitForAuthResume;
    if (waiting) await readonlyAwait(waiting(session), session.abort.signal);
  }
  async #pause(session: AgentSession, reason: string): Promise<void> {
    await session.waitForControl();
    const after = session.inboxSequence;
    this.#state(session, "paused", reason);
    if (reason === "chatgpt account changed" && this.#deps.waitForAuthResume)
      await this.#authResume(session);
    else await session.waitForResume(after);
    await session.waitForControl();
  }
  #recap(session: AgentSession, redact: Redactor, suffix: string): string {
    const messages = this.#deps.transcripts.read(session.id),
      user = messages.filter((m) => m.sourceInbox && typeof m.content === "string"),
      last = messages
        .filter((m) => m.role === "assistant" && typeof m.content === "string")
        .at(-1)?.content;
    const marks = { done: "x", doing: ">", skipped: "-", todo: " " };
    const earlier = earlierRecord(session.earlier);
    const text = redact(
      `localDot restarted you, so the earlier conversation is gone.${earlier ? `\n${earlier}` : ""}\nThe task: ${session.task}\nThe plan so far:\n${session.plan.length ? session.plan.map((item) => `[${marks[item.status]}] ${item.text}`).join("\n") : "(no plan yet)"}${user.length ? `\nWhat the user said since the task:\n${user.map((m) => m.content).join("\n")}` : ""}${last ? `\nYour last message to the user: ${last}` : ""}\nUse the full screenshot in this turn to see where things stand, then continue.${suffix ? `\n${suffix}` : ""}${this.#resumeNotes.get(session) ? `\n${this.#resumeNotes.get(session)}` : ""}`,
    );
    if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) throw new Error("The task recap is too large.");
    return text;
  }
  async #cycle(
    session: AgentSession,
    generation: BrainGeneration,
    lease: CodexDriverLease,
    model: string,
    recap: boolean,
    suffix: string,
    redact: Redactor,
    publish: (cycle: ActiveCycle) => void,
  ): Promise<CycleResult> {
    const d = this.#deps,
      lifetime = new AbortController(),
      completion = deferred<CycleResult>(),
      retired = deferred<void>();
    const signal = AbortSignal.any([
      session.abort.signal,
      generation.signal,
      lease.signal,
      lifetime.signal,
    ]);
    const holders = new Set<TaskConnection>(),
      stops = new Map<TaskConnection, Promise<void>>(),
      pending = new Set<string>();
    let conn: TaskConnection | undefined,
      endpoint: McpEndpoint | undefined,
      endpointClose: Promise<void> | undefined,
      mapper: CodexEventMapper | undefined,
      epoch: CodexTurnEpoch | undefined,
      epochAbort: AbortController | undefined,
      mainThread: string | undefined,
      wireTurn: string | undefined,
      result: CycleResult | undefined,
      savedAssistant: string | undefined,
      fenced = false,
      nativeUncertain = false;
    let pauseInterruptOwner: Pick<PauseSnapshot, "requestId" | "revision"> | undefined;
    let pauseWork: Promise<{ generationId: number; completedCalls: number }> | undefined;
    const current = () =>
      !fenced &&
      !signal.aborted &&
      session.isCurrent(generation) &&
      !session.controlHeld &&
      lease.generation === d.auth.authGeneration;
    const check = () => {
      if (!current()) throw new Error("The Codex turn was retired.");
      session.check(generation, signal);
    };
    const stopHolder = (holder: TaskConnection) => {
      if (stops.has(holder)) return;
      let stopping: Promise<void>;
      try {
        stopping = Promise.all([holder.stop(), holder.closed]).then(() => {});
      } catch {
        stopping = Promise.reject(new CodexCleanupError());
      }
      void stopping.catch(() => {});
      stops.set(holder, stopping);
    };
    const closeEndpoint = () => {
      if (!endpoint || endpointClose) return;
      try {
        endpointClose = endpoint.close();
      } catch {
        endpointClose = Promise.reject(new CodexCleanupError());
      }
      void endpointClose.catch(() => {});
    };
    const fence = () => {
      if (fenced) return;
      fenced = true;
      mapper?.close();
      if (epoch) endpoint?.retireTurn(epoch);
      epochAbort?.abort();
      lifetime.abort();
      session.retireBrain(generation);
      closeEndpoint();
      for (const holder of holders) stopHolder(holder);
    };
    const saveAssistant = () => {
      const text = mapper?.lastAssistantText();
      if (current() && text && text !== savedAssistant) {
        const safe = redact(text);
        if (!current()) return;
        session.appendTranscript(
          d.transcripts,
          generation,
          { messages: [{ role: "assistant", content: safe }] },
          signal,
        );
        savedAssistant = text;
      }
    };
    const finish = (candidate: CycleResult) => {
      if (result) return;
      if (
        session.safetyPause &&
        !["safety", "retired", "control", "auth", "crashed", "signed_out", "plan_limit"].includes(
          candidate.kind,
        )
      ) {
        if (candidate.kind !== "done" && candidate.kind !== "completed") nativeUncertain = true;
        return;
      }
      result = candidate;
      try {
        saveAssistant();
      } catch {
        result = { kind: "failed", message: "The task history could not be saved." };
      }
      fence();
      completion.resolve(result);
    };
    const launcherFence = () => {
      if (fenced) return;
      fence();
      // The launcher fences before reporting a typed failure. Its reentrant Stop can also
      // suppress that report, so resolve after synchronous observers have had their chance.
      queueMicrotask(() => {
        if (result) return;
        finish(
          session.stopped
            ? { kind: "retired" }
            : lease.generation !== d.auth.authGeneration || lease.signal.aborted
              ? { kind: "auth" }
              : session.controlHeld
                ? { kind: "control" }
                : { kind: "crashed" },
        );
      });
    };
    const done = (): CycleResult =>
      pending.size ? { kind: "completed", pending: true } : { kind: "done" };
    const loss = () => {
      if (fenced) return;
      finish(
        lease.generation !== d.auth.authGeneration || lease.signal.aborted
          ? { kind: "auth" }
          : session.controlHeld
            ? { kind: "control" }
            : { kind: "retired" },
      );
    };
    const fail = (cause: CodexLaunchError) => {
      if (["process_exited", "transport_failed", "startup_failed"].includes(cause.code))
        finish({ kind: "crashed" });
      else finish({ kind: "failed", message: "The ChatGPT connection could not start." });
    };
    const register = (holder: TaskConnection) => {
      if (holders.has(holder)) return;
      holders.add(holder);
      if (!conn) conn = holder;
      else if (conn !== holder)
        finish({ kind: "failed", message: "The ChatGPT task registered an unexpected process." });
      void holder.failure.then(fail).catch(() => finish({ kind: "crashed" }));
      void holder.exited
        .then(() => {
          if (!fenced) finish({ kind: "crashed" });
        })
        .catch(() => {
          if (!fenced) finish({ kind: "crashed" });
        });
      if (fenced) stopHolder(holder);
    };
    const identity = (): ApprovalIdentity =>
      Object.freeze({
        generation,
        authGeneration: lease.generation,
        turn: epoch ?? Object.freeze({ id: 0, basisFrameId: "", signal: AbortSignal.abort() }),
        mainThreadId: mainThread,
        turnId: wireTurn,
        controlHeld: session.controlHeld,
      });
    const guardedAppend = (type: string, data: Record<string, unknown>, step?: string) => {
      check();
      session.append(type, data, step);
      check();
    };
    const blocked = (step: BlockedStep) => {
      if (!current()) return;
      try {
        const id = ulid();
        guardedAppend("step.start", { kind: step.kind }, id);
        guardedAppend("tool.start", { tool: step.tool, title: step.note }, id);
        guardedAppend("tool.end", { ok: false }, id);
        guardedAppend("step.end", { status: "blocked", note: step.note }, id);
      } catch {
        finish({ kind: "failed", message: "The ChatGPT task could not record an event." });
      }
    };
    const notification: TaskLaunch["onNotification"] = (method, params, context) => {
      if (!current() || context.signal.aborted || !mapper) return;
      const mapped = mapper.handle(method, params);
      try {
        saveAssistant();
      } catch {
        finish({ kind: "failed", message: "The task history could not be saved." });
        return;
      }
      for (const item of mapped) {
        if (!current()) break;
        if (item.kind === "turn_started") {
          if (wireTurn && wireTurn !== item.turnId)
            finish({ kind: "violation", what: "sub_agent" });
          else wireTurn = item.turnId;
        } else if (item.kind === "violation") {
          blocked({ kind: "think", tool: "codex.disabled", note: item.detail });
          finish({ kind: "violation", what: item.what });
        } else if (item.kind === "turn_completed") {
          const outcome = turnOutcome(item.turn);
          // The interrupt issued only after MCP result ownership and step drain is expected.
          // An unsolicited interruption, an owner change, or an unacknowledged RPC remains uncertain.
          if (
            outcome.kind === "interrupted" &&
            pauseInterruptOwner &&
            session.safetyPause?.requestId === pauseInterruptOwner.requestId &&
            session.safetyPause.revision === pauseInterruptOwner.revision
          )
            continue;
          if (outcome.kind === "completed")
            finish({ kind: "completed", pending: pending.size > 0 });
          else if (outcome.kind === "signed_out") {
            d.auth.markSignedOut(lease.generation);
            finish({ kind: "signed_out" });
          } else if (outcome.kind === "plan_limit") finish({ kind: "plan_limit" });
          else if (outcome.kind === "retry" || outcome.kind === "failed") finish(outcome);
          else finish({ kind: "failed", message: "The ChatGPT turn was interrupted." });
        }
      }
    };
    const onResult = (tool: string, value: ToolResult, context: McpCallContext) => {
      if (
        !current() ||
        !epoch ||
        context.turnEpoch !== epoch ||
        context.generation !== generation ||
        context.authGeneration !== lease.generation ||
        context.basisFrameId !== epoch.basisFrameId ||
        !(context.signal instanceof AbortSignal) ||
        context.signal.aborted
      )
        return;
      if (session.safetyPause) return;
      if (tool === "done" && value.ok) finish(done());
      else if (value.final) finish({ kind: "done" });
    };
    signal.addEventListener("abort", loss, { once: true });
    const removeControlObserver = session.onControlRequested(generation, () =>
      finish({ kind: "control" }),
    );
    const pauseAtBoundary: ActiveCycle["pauseAtBoundary"] = (pause) => {
      if (pauseWork) return pauseWork;
      pauseWork = (async () => {
        const pauseCurrent = () => {
          check();
          if (
            session.safetyPause?.requestId !== pause.requestId ||
            session.safetyPause.revision !== pause.revision ||
            nativeUncertain
          )
            throw new CodexCleanupError();
        };
        pauseCurrent();
        await session.safetyBoundary(signal);
        pauseCurrent();
        const heldEndpoint = endpoint;
        let receipt: McpPauseReceipt | undefined;
        if (heldEndpoint) receipt = await heldEndpoint.pauseAtBoundary(epoch, pause);
        pauseCurrent();
        if (mainThread && wireTurn && conn) {
          pauseInterruptOwner = Object.freeze({
            requestId: pause.requestId,
            revision: pause.revision,
          });
          await readonlyAwait(
            conn.rpc.request(
              "turn/interrupt",
              { threadId: mainThread, turnId: wireTurn },
              { signal, validateResult: opaqueObject },
            ),
            signal,
          );
          pauseCurrent();
        }
        if (heldEndpoint && (!receipt || !heldEndpoint.validatePauseReceipt(receipt)))
          throw new CodexCleanupError();
        // Interrupt acknowledgement alone is insufficient. Resolve only after process, pipes,
        // MCP capability and the credential lease are physically closed by normal cleanup.
        finish({ kind: "safety" });
        await retired.promise;
        if (result?.kind !== "safety" || nativeUncertain) throw new CodexCleanupError();
        return { generationId: generation.id, completedCalls: receipt?.completedCalls ?? 0 };
      })();
      void pauseWork.catch(() => {});
      return pauseWork;
    };
    publish({ finish, fence, pauseAtBoundary });
    const startupTimer = setTimeout(
      () => finish({ kind: "failed", message: "The ChatGPT task did not start in time." }),
      20000,
    );
    startupTimer.unref();
    const heartbeatMs = Math.max(1, d.heartbeatMs ?? 1000);
    const heartbeat = setInterval(() => {
      if (!current()) {
        loss();
        return;
      }
      if (session.status === "running" || session.safetyPause?.phase === "pausing") {
        try {
          guardedAppend("heartbeat", { ongoing: true, everyMs: heartbeatMs });
        } catch {
          finish({ kind: "failed", message: "The ChatGPT task could not record an event." });
        }
      }
    }, heartbeatMs);
    const persist = (items: InboxItem[]) => {
      const texts: InboxItem[] = [];
      for (let offset = 0; offset < items.length; offset += 64) {
        check();
        const batch = items.slice(offset, offset + 64);
        for (const item of batch)
          if (item.kind !== "resume" && redact(item.text) !== item.text)
            throw new Error("Protected input cannot be persisted.");
        const messages = batch
          .filter((i) => i.kind !== "resume")
          .map((item) => ({
            role: "user" as const,
            content: item.text,
            sourceInbox: { seq: item.seq, messageId: item.messageId },
          }));
        // Ack proves durable storage, not delivery to the model. Track uncertainty before
        // fsync/ack so even a completion during storage cannot strand the fetched input.
        for (const item of batch) if (item.kind !== "resume") pending.add(item.messageId);
        session.appendTranscript(
          d.transcripts,
          generation,
          { messages, inboxAfter: batch.at(-1)?.seq },
          signal,
        );
        check();
        texts.push(...batch.filter((i) => i.kind !== "resume"));
      }
      return texts;
    };
    const request = <T>(
      method: Parameters<TaskConnection["rpc"]["request"]>[0],
      params: unknown,
      validateResult: RpcRequestOptions<T>["validateResult"],
    ): Promise<T> => {
      check();
      if (session.safetyPause)
        return Promise.reject(new Error("Native startup is fenced by Pause."));
      if (!conn) return Promise.reject(new Error("Missing Codex connection."));
      return readonlyAwait(
        conn.rpc.request(method, params, { signal, validateResult }),
        signal,
      ).then((value) => {
        check();
        return value;
      });
    };
    const inboxLoop = async () => {
      while (current()) {
        const batch = await session.inbox(session.delivered, heartbeatMs, signal, generation);
        if (!current()) {
          loss();
          return;
        }
        for (const item of persist(batch.items)) {
          check();
          if (item.kind !== "steer" || !wireTurn || session.safetyPause) continue;
          const expected = wireTurn;
          try {
            await request(
              "turn/steer",
              {
                threadId: mainThread,
                expectedTurnId: expected,
                input: [{ type: "text", text: redact(item.text) }],
              },
              (value) => {
                const result = opaqueObject(value);
                if (result.turnId !== expected) throw new Error("Unexpected Codex steer response.");
                return result;
              },
            );
            pending.delete(item.messageId);
          } catch {
            if (!current()) return;
            // RpcError carries only a numeric code, which cannot prove remote refusal versus
            // local timeout/retirement. Recover from durable input on a fresh owned connection.
            finish({ kind: "input" });
          }
        }
      }
    };
    const startup = (async () => {
      check();
      await session.prepareScreens(generation);
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      endpoint = await d.openEndpoint({
        session,
        generation,
        authGeneration: lease.generation,
        currentAuthGeneration: () => d.auth.authGeneration,
        authSignal: lease.signal,
        signal,
        onResult,
        onRetire: (reason) => {
          if (!current()) return;
          finish(
            reason === "stale"
              ? { kind: "stale" }
              : reason === "done"
                ? done()
                : { kind: "failed", message: "The ChatGPT tool bridge was retired." },
          );
        },
      });
      if (fenced) closeEndpoint();
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      const launched = await lease.launch({
        sessionId: session.id,
        endpoint,
        signal,
        onRegister: register,
        isCurrent: current,
        onFence: launcherFence,
        approvalContext: () => ({
          captured: identity(),
          current: () => (current() ? identity() : undefined),
        }),
        onBlocked: blocked,
        onNotification: notification,
        onFailure: fail,
        interruptTurn: () =>
          mainThread && wireTurn ? { threadId: mainThread, turnId: wireTurn } : undefined,
      });
      register(launched);
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      await request(
        "initialize",
        { clientInfo: { name: "localdot", title: "localDot", version: "0.0.0" } },
        opaqueObject,
      );
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      conn?.rpc.notify("initialized", {});
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      const account = await request("account/read", { refreshToken: false }, AccountRead.parse);
      if (account.account?.type !== "chatgpt") {
        d.auth.markSignedOut(lease.generation);
        finish({ kind: "signed_out" });
        return;
      }
      const thread = await request(
        "thread/start",
        threadStartParams({
          cwd: launched.workDir,
          model,
          developerInstructions: redact(d.instructions(session)),
        }),
        ThreadStartResult.parse,
      );
      if (thread.model !== model || thread.approvalsReviewer !== "user")
        throw new Error("Unexpected Codex thread configuration.");
      mainThread = thread.thread.id;
      session.restoreDelivered(d.transcripts);
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      if (redact(session.task) !== session.task)
        throw new Error("Protected task input cannot be persisted.");
      if (
        !d.transcripts
          .read(session.id)
          .some((m) => m.role === "user" && !m.sourceInbox && m.content === session.task)
      )
        session.appendTranscript(
          d.transcripts,
          generation,
          { messages: [{ role: "user", content: session.task }] },
          signal,
        );
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      const unread = await session.inbox(session.delivered, 0, signal, generation);
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      const initial = persist(unread.items);
      const text = recap
        ? this.#recap(session, redact, suffix)
        : redact(
            [earlierRecord(session.earlier), session.task, ...initial.map((i) => i.text)]
              .filter((part) => part !== undefined)
              .join("\n\n"),
          );
      if (Buffer.byteLength(text) > MAX_PROMPT_BYTES)
        throw new Error("The task input is too large.");
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      const observation = await d.observe(session, generation, signal);
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      if (
        observation.full !== true ||
        !ULID_PATTERN.test(observation.frameId) ||
        !Buffer.isBuffer(observation.png) ||
        observation.png.length > 4 * 1024 * 1024 ||
        !observation.png.subarray(0, 8).equals(PNG_HEADER)
      )
        throw new Error("Invalid full screenshot.");
      const image = Buffer.from(observation.png);
      epochAbort = new AbortController();
      epoch = Object.freeze({
        id: generation.id,
        signal: epochAbort.signal,
        basisFrameId: observation.frameId,
      });
      endpoint.setTurn(epoch);
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      mapper = new CodexEventMapper({
        session,
        generation,
        turn: epoch,
        isTurnCurrent: (candidate) => current() && candidate === epoch,
        authGeneration: lease.generation,
        currentAuthGeneration: () => d.auth.authGeneration,
        authSignal: lease.signal,
        signal,
        model,
        mainThreadId: () => mainThread,
        redact,
        onFailure: () =>
          finish({ kind: "failed", message: "The ChatGPT event stream could not be processed." }),
      });
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      session.tainted = true;
      session.taintScreen(observation.screen ?? "desktop");
      const started = await request(
        "turn/start",
        {
          threadId: mainThread,
          input: [
            { type: "text", text },
            { type: "image", url: `data:image/png;base64,${image.toString("base64")}` },
          ],
        },
        TurnStartResult.parse,
      );
      if (started.turn.status !== "inProgress" || (wireTurn && wireTurn !== started.turn.id))
        throw new Error("Unexpected Codex turn.");
      if (!wireTurn)
        notification("turn/started", { threadId: mainThread, turn: started.turn }, { signal });
      check();
      if (session.safetyPause) throw new Error("Native startup is fenced by Pause.");
      for (const item of initial) pending.delete(item.messageId);
      clearTimeout(startupTimer);
      void inboxLoop().catch(() => {
        if (!current()) loss();
        else finish({ kind: "failed", message: "The task input could not be saved." });
      });
    })().catch((cause) => {
      if (result) return;
      if (current() && session.safetyPause) return;
      if (!current()) {
        loss();
        if (!result) finish({ kind: "failed", message: "The ChatGPT connection was retired." });
      } else if (cause instanceof CodexLaunchError) fail(cause);
      else finish({ kind: "failed", message: "The ChatGPT task could not start." });
    });
    const outcome = await completion.promise;
    fence();
    clearTimeout(startupTimer);
    clearInterval(heartbeat);
    signal.removeEventListener("abort", loss);
    removeControlObserver();
    const cleanup = startup.then(async () => {
      closeEndpoint();
      for (const holder of holders) stopHolder(holder);
      await Promise.all([
        ...stops.values(),
        ...(endpointClose ? [endpointClose] : []),
        lease.release(),
        session.toolsSettled(),
      ]);
    });
    try {
      await retirementDeadline(cleanup);
      // Remove only this exact cycle after cleanup, before publishing a resumable receipt.
      const owner = this.#owners.get(session.id);
      if (owner?.active?.pauseAtBoundary === pauseAtBoundary) {
        owner.active = undefined;
        owner.lease = undefined;
      }
      retired.resolve();
    } catch {
      retired.reject(new CodexCleanupError());
      this.#blocked.add(session.id);
      throw new CodexCleanupError();
    }
    return outcome;
  }
}
