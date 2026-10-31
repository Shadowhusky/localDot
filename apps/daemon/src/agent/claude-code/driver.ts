import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Options,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelOptions } from "@localdot/protocol";
import {
  CLAUDE_CODE_MODEL,
  earlierRecord,
  type InboxItem,
  isToolName,
  MAX_BATCH_STEPS,
  type PauseSnapshot,
  type ToolResult,
  ULID_PATTERN,
  ulid,
} from "@localdot/protocol";
import { connectorDescriptors, type McpCallResult, toCallToolResult } from "../codex/mcp-tools.ts";
import type { NativePauseReceipt } from "../codex/native-pause.ts";
import { NativeRetirement } from "../native-retirement.ts";
import { RETRY_NEXT, toolList, UNNAMED_TOOL } from "../native-tools.ts";
import { type Redactor, redactor } from "../redact.ts";
import type { AgentSession, BrainGeneration } from "../session.ts";
import type { TranscriptStore } from "../transcript.ts";
import { ClaudeCodeEventMapper, type ClaudeSignal } from "./events.ts";
import { type LocaldotCall, localdotServer } from "./mcp-server.ts";
import { claudeCodeOptions } from "./options.ts";
import { type ClaudeCodeLaunch, ClaudeCodeUnavailable } from "./setup.ts";

export const CLAUDE_CODE_DONE = 0;
export const CLAUDE_CODE_GAVE_UP = 3;
export const CLAUDE_CODE_CRASHED = 70;
const NUDGE =
  "If the requested outcome is complete, call the localdot done tool with completion.status complete and observed evidence. If work is waiting for another actor, processing, loading or a timer, use done with completion.status waiting or computer wait, then inspect and continue. Waiting is not completion or a blocker. Use ask_user only for missing user information; otherwise continue the task.";
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PROMPT_BYTES = 256 * 1024;
// Rounds of refused calls to other tools, with no localDot tool call between, before localDot stops.
const MAX_REFUSALS = 3;
const MAX_LEARNED = 64;
// Claude Code shows it to Claude as a message from the user, so it says who it is from.
const unavailable = (tools: readonly string[]) =>
  `From localDot, not the user: ${tools.join(", ")} ${tools.length > 1 ? "are" : "is"} not available here. Use only localDot's tools (mcp__localdot__…) for this task.`;
const SIGNED_OUT = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
]);

export interface ClaudeQuery extends AsyncIterable<unknown> {
  close(): void;
}
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;
export interface ClaudeCodeDriverDeps {
  readonly query: QueryFn;
  // The user's own signed-in Claude Code, checked again for each run.
  readonly launch: () => Promise<ClaudeCodeLaunch>;
  readonly spawn: (options: SpawnOptions, session: AgentSession) => SpawnedProcess;
  readonly dispatch: (
    session: AgentSession,
    generation: BrainGeneration,
    name: string,
    callId: string,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<ToolResult>;
  readonly observe: (
    session: AgentSession,
    generation: BrainGeneration,
    signal: AbortSignal,
  ) => Promise<{ frameId: string; full: true; png: Buffer }>;
  readonly transcripts: TranscriptStore;
  readonly instructions: (session: AgentSession) => string;
  readonly redactorFor?: (session: AgentSession) => Redactor;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly heartbeatMs?: number;
  readonly onRetired?: (sessionId: string) => void;
  readonly startupMs?: number;
  readonly exitMs?: number;
}
export class ClaudeCodeCleanupError extends Error {
  constructor() {
    super("The Claude Code task could not be safely retired.");
    this.name = "ClaudeCodeCleanupError";
  }
}
type CycleResult =
  | { kind: "completed"; pending: boolean }
  | {
      kind: "done" | "retired" | "control" | "crashed" | "signed_out" | "plan_limit" | "safety";
      detail?: string;
    }
  | { kind: "offered"; tools: string[]; unnamed: boolean; version?: string }
  | { kind: "violation"; what: "foreign_tool" | "refused"; tool: string }
  | { kind: "violation"; what: "sub_agent" }
  | { kind: "retry" | "failed"; message: string };
interface ActiveCycle {
  finish(result: CycleResult): void;
  pauseAtBoundary(
    pause: Pick<PauseSnapshot, "requestId" | "revision">,
  ): Promise<{ generationId: number; completedCalls: number }>;
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ClaudeCodeCleanupError()), ms);
    work
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
      .catch(() => {});
  });
}
const text = (value: string) => ({ type: "text" as const, text: value });
const inactive = (): McpCallResult => ({
  isError: true,
  content: [text("This step is no longer active.")],
});

// The prompt stream Claude Code reads: dot's task, then the user's messages as they arrive.
class Inputs implements AsyncIterable<SDKUserMessage> {
  readonly #items: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  push(content: SDKUserMessage["message"]["content"]): string | undefined {
    if (this.#ended) return undefined;
    const uuid = randomUUID();
    this.#items.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      uuid,
      session_id: "",
    } as SDKUserMessage);
    this.#wake?.();
    return uuid;
  }
  end(): void {
    this.#ended = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}

// Each run is one Claude Code process with its own MCP server, BrainGeneration and screen basis.
// Pause, takeover, Stop and sign-in changes retire the process; the next run continues from the
// task's saved history, as the ChatGPT plan's Codex does.
export class ClaudeCodeDriver {
  readonly #deps: ClaudeCodeDriverDeps;
  readonly #running = new Set<string>();
  readonly #blocked = new Set<string>();
  readonly #owners = new Map<string, { session: AgentSession; active?: ActiveCycle }>();
  readonly #pauseReceipts = new WeakMap<AgentSession, NativePauseReceipt>();
  readonly #resumeNotes = new WeakMap<AgentSession, string>();
  readonly #retirement: NativeRetirement;
  // Built-ins a newer Claude Code turned on, switched off by name in every later run.
  readonly #learned = new Set<string>();
  constructor(deps: ClaudeCodeDriverDeps) {
    this.#deps = Object.freeze({ ...deps });
    this.#retirement = new NativeRetirement(deps.onRetired);
  }
  retirementConfirmed(sessionId: string): boolean {
    return this.#retirement.confirmed(sessionId);
  }
  async pauseAtBoundary(
    session: AgentSession,
    pause: Pick<PauseSnapshot, "requestId" | "revision">,
  ): Promise<NativePauseReceipt> {
    const check = () => {
      if (
        session.stopped ||
        session.controlHeld ||
        this.#blocked.has(session.id) ||
        session.safetyPause?.requestId !== pause.requestId ||
        session.safetyPause.revision !== pause.revision
      )
        throw new ClaudeCodeCleanupError();
    };
    check();
    const previous = this.#pauseReceipts.get(session);
    if (previous) {
      if (previous.requestId !== pause.requestId || previous.revision !== pause.revision)
        throw new ClaudeCodeCleanupError();
      return previous;
    }
    const owner = this.#owners.get(session.id);
    if (owner && owner.session !== session) throw new ClaudeCodeCleanupError();
    const facts = owner?.active ? await owner.active.pauseAtBoundary(pause) : undefined;
    check();
    if (owner?.active || session.generation) throw new ClaudeCodeCleanupError();
    const receipt: NativePauseReceipt = Object.freeze({
      sessionId: session.id,
      requestId: pause.requestId,
      revision: pause.revision,
      authGeneration: 0,
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
      this.#blocked.has(session.id) ||
      this.#owners.get(session.id)?.active ||
      session.generation
    )
      throw new ClaudeCodeCleanupError();
    this.#pauseReceipts.delete(session);
    this.#resumeNotes.set(
      session,
      `The previous run and all its calls were retired before Pause. ${receipt.completedCalls} call results were confirmed. Do not replay any previous tool call. Choose fresh work from the current full screenshot.`,
    );
  }
  async run(
    session: AgentSession,
    input: { model: string; options?: ModelOptions; resume: boolean },
  ): Promise<number> {
    if (this.#blocked.has(session.id)) throw new ClaudeCodeCleanupError();
    if (this.#running.has(session.id)) throw new Error("The Claude Code task is already running.");
    if (session.stopped) return CLAUDE_CODE_DONE;
    if (typeof input.model !== "string" || !CLAUDE_CODE_MODEL.test(input.model)) {
      this.#state(session, "error", "The Claude Code model selection is invalid.");
      return CLAUDE_CODE_GAVE_UP;
    }
    this.#retirement.begin(session.id);
    this.#running.add(session.id);
    const owner: { session: AgentSession; active?: ActiveCycle } = { session };
    this.#owners.set(session.id, owner);
    const d = this.#deps,
      redact = d.redactorFor?.(session) ?? redactor([]);
    let recap = input.resume,
      next = "",
      retries = 0,
      relaunched = false;
    const stopped = () => owner.active?.finish({ kind: "retired" });
    session.abort.signal.addEventListener("abort", stopped, { once: true });
    try {
      while (!session.stopped) {
        await session.waitForSafety();
        await session.waitForControl();
        await session.waitForTools();
        if (session.stopped) break;
        const generation = session.beginBrain();
        session.setStatus("running");
        const result = await this.#cycle(
          session,
          generation,
          input.model,
          input.options,
          recap,
          next,
          redact,
          [...this.#learned],
          {
            publish: (cycle) => {
              owner.active = cycle;
            },
            retire: () => {
              owner.active = undefined;
            },
          },
        );
        recap = true;
        if (result.kind === "safety") {
          await session.waitForSafety();
          next = "Continue after explicit safety Resume. Do not replay a completed call.";
          continue;
        }
        if (session.stopped || result.kind === "done" || result.kind === "retired")
          return CLAUDE_CODE_DONE;
        if (result.kind === "crashed") return CLAUDE_CODE_CRASHED;
        if (result.kind === "control") {
          await session.waitForControl();
          next = "Continue after the user's hand-back.";
          continue;
        }
        if (result.kind === "signed_out" || result.kind === "plan_limit") {
          await this.#pause(
            session,
            result.kind === "signed_out"
              ? "claude code sign-in expired"
              : "claude code plan limit reached",
            result.detail,
          );
          next = "Continue.";
          retries = 0;
          continue;
        }
        if (result.kind === "offered") {
          // A Claude Code update can turn a new built-in on. Switch it off by name and start
          // again, once; one that stays on could run without localDot's approval.
          const fresh = result.tools.filter((tool) => !this.#learned.has(tool));
          if (
            !relaunched &&
            !result.unnamed &&
            fresh.length &&
            this.#learned.size + fresh.length <= MAX_LEARNED
          ) {
            relaunched = true;
            for (const tool of fresh) this.#learned.add(tool);
            console.warn(
              `claude code ${result.version ?? "(unknown version)"} offers its own ${fresh.join(", ")}; switching it off and starting again (task ${session.id})`,
            );
            continue;
          }
          const tools = [...result.tools, ...(result.unnamed ? [UNNAMED_TOOL] : [])];
          this.#stop(
            session,
            `Claude Code${result.version ? ` ${result.version}` : ""} turns on its own tool ${toolList(tools)}, which localDot couldn't switch off, so localDot stopped the task`,
            "Update Claude Code, or choose another model in Settings, then send your message again.",
          );
          return CLAUDE_CODE_GAVE_UP;
        }
        if (result.kind === "violation") {
          this.#stop(
            session,
            result.what === "sub_agent"
              ? "Claude Code started a sub-agent; localDot stopped the task"
              : result.what === "refused"
                ? `Claude kept asking for ${result.tool}, which isn't one of localDot's tools, so localDot stopped the task`
                : `Claude Code used its own tool ${result.tool} instead of localDot's, so localDot stopped the task`,
            RETRY_NEXT,
          );
          return CLAUDE_CODE_GAVE_UP;
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
          return CLAUDE_CODE_GAVE_UP;
        }
        retries = 0;
        if (result.kind === "completed" && result.pending) {
          next = "Continue with the user's follow-up.";
          continue;
        }
        this.#state(session, "idle", "no result");
        return CLAUDE_CODE_GAVE_UP;
      }
      return CLAUDE_CODE_DONE;
    } catch (cause) {
      if (cause instanceof ClaudeCodeCleanupError) {
        this.#blocked.add(session.id);
        throw cause;
      }
      if (session.stopped) return CLAUDE_CODE_DONE;
      this.#state(session, "error", "The Claude Code task could not continue.");
      return CLAUDE_CODE_GAVE_UP;
    } finally {
      session.abort.signal.removeEventListener("abort", stopped);
      this.#owners.delete(session.id);
      this.#running.delete(session.id);
      this.#retirement.end(session.id);
    }
  }
  #state(
    session: AgentSession,
    state: "paused" | "idle" | "error",
    reason: string,
    detail?: string,
  ): void {
    if (session.stopped || session.controlHeld) return;
    if (state !== "error") session.setStatus(state);
    session.append("agent.state", { state, reason, ...(detail ? { detail } : {}) });
  }
  // A stop over a tool that is not localDot's: what happened and what the user can do about it.
  #stop(session: AgentSession, reason: string, next: string): void {
    const said = reason.length > 200 ? `${reason.slice(0, 199)}…` : reason;
    console.error(`claude code: ${said} (task ${session.id})`);
    if (session.stopped || session.controlHeld) return;
    session.append("agent.state", { state: "error", reason: said, next });
  }
  async #pause(session: AgentSession, reason: string, detail?: string): Promise<void> {
    await session.waitForControl();
    const after = session.inboxSequence;
    this.#state(session, "paused", reason, detail);
    await session.waitForResume(after);
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
    const note = this.#resumeNotes.get(session);
    this.#resumeNotes.delete(session);
    const text = redact(
      `localDot restarted you, so the earlier conversation is gone.${earlier ? `\n${earlier}` : ""}\nThe task: ${session.task}\nThe plan so far:\n${session.plan.length ? session.plan.map((item) => `[${marks[item.status]}] ${item.text}`).join("\n") : "(no plan yet)"}${user.length ? `\nWhat the user said since the task:\n${user.map((m) => m.content).join("\n")}` : ""}${last ? `\nYour last message to the user: ${last}` : ""}\nUse the full screenshot in this turn to see where things stand, then continue.${suffix ? `\n${suffix}` : ""}${note ? `\n${note}` : ""}`,
    );
    if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) throw new Error("The task recap is too large.");
    return text;
  }
  async #cycle(
    session: AgentSession,
    generation: BrainGeneration,
    model: string,
    options: ModelOptions | undefined,
    recap: boolean,
    suffix: string,
    redact: Redactor,
    disallowed: readonly string[],
    owner: { publish(cycle: ActiveCycle): void; retire(): void },
  ): Promise<CycleResult> {
    const d = this.#deps,
      lifetime = new AbortController(),
      abort = new AbortController(),
      completion = deferred<CycleResult>(),
      retired = deferred<void>(),
      inputs = new Inputs();
    const signal = AbortSignal.any([session.abort.signal, generation.signal, lifetime.signal]);
    // The user's messages sent to Claude Code that no request has taken in yet, by their inbox seq.
    const pending = new Map<string, number>(),
      children = new Set<{ child: SpawnedProcess; exited: Promise<void> }>();
    let result: CycleResult | undefined,
      query: ReturnType<QueryFn> | undefined,
      consuming: Promise<void> = Promise.resolve(),
      calls: Promise<unknown> = Promise.resolve(),
      inFlight = 0,
      completedCalls = 0,
      fenced = false,
      admitting = true,
      nudged = false,
      acting = false,
      refusals = 0,
      basis = "",
      returned = "";
    const settledWaiters = new Set<() => void>();
    const current = () =>
      !fenced && !signal.aborted && session.isCurrent(generation) && !session.controlHeld;
    const check = () => {
      if (!current()) throw new Error("The Claude Code run was retired.");
      session.check(generation, signal);
    };
    const kill = (sig: NodeJS.Signals) => {
      for (const { child } of children)
        if (child.exitCode === null && !child.signalCode) child.kill(sig);
    };
    const fence = () => {
      if (fenced) return;
      fenced = true;
      admitting = false;
      lifetime.abort();
      inputs.end();
      session.retireBrain(generation);
      try {
        query?.close();
      } catch {
        /* The process is stopped below. */
      }
      abort.abort();
      kill("SIGTERM");
    };
    const finish = (candidate: CycleResult) => {
      if (result) return;
      if (
        session.safetyPause &&
        ![
          "safety",
          "retired",
          "control",
          "crashed",
          "signed_out",
          "plan_limit",
          "offered",
          "violation",
        ].includes(candidate.kind)
      )
        return;
      result = candidate;
      fence();
      completion.resolve(result);
    };
    const guarded = (type: string, data: Record<string, unknown>) => {
      if (!current()) return;
      try {
        session.append(type, data);
      } catch {
        finish({ kind: "failed", message: "The Claude Code task could not record an event." });
      }
    };
    const said = (reply: string) => {
      if (!current()) return;
      try {
        session.appendTranscript(
          d.transcripts,
          generation,
          { messages: [{ role: "assistant", content: reply }] },
          signal,
        );
      } catch {
        finish({ kind: "failed", message: "The task history could not be saved." });
      }
    };
    const loss = () => finish(session.controlHeld ? { kind: "control" } : { kind: "retired" });
    signal.addEventListener("abort", loss, { once: true });
    const removeControlObserver = session.onControlRequested(generation, () =>
      finish({ kind: "control" }),
    );
    const callsSettled = () =>
      new Promise<void>((resolve) => {
        if (!inFlight) return resolve();
        settledWaiters.add(resolve);
      });
    let pauseWork: Promise<{ generationId: number; completedCalls: number }> | undefined;
    const pauseAtBoundary: ActiveCycle["pauseAtBoundary"] = (pause) => {
      pauseWork ??= (async () => {
        const pauseCurrent = () => {
          check();
          if (
            session.safetyPause?.requestId !== pause.requestId ||
            session.safetyPause.revision !== pause.revision
          )
            throw new ClaudeCodeCleanupError();
        };
        pauseCurrent();
        admitting = false;
        await session.safetyBoundary(signal);
        pauseCurrent();
        await within(callsSettled(), 2000);
        pauseCurrent();
        finish({ kind: "safety" });
        await retired.promise;
        if (result?.kind !== "safety") throw new ClaudeCodeCleanupError();
        return { generationId: generation.id, completedCalls };
      })();
      void pauseWork.catch(() => {});
      return pauseWork;
    };
    owner.publish({ finish, pauseAtBoundary });
    const heartbeatMs = Math.max(1, d.heartbeatMs ?? 1000);
    const heartbeat = setInterval(() => {
      if (!current()) return loss();
      if (session.status === "running" || session.safetyPause?.phase === "pausing")
        guarded("heartbeat", { ongoing: true, everyMs: heartbeatMs });
    }, heartbeatMs);
    const startupTimer = setTimeout(
      () => finish({ kind: "failed", message: "Claude Code did not start in time." }),
      d.startupMs ?? 30_000,
    );
    startupTimer.unref();
    const persist = (items: InboxItem[]) => {
      const texts: InboxItem[] = [];
      for (let offset = 0; offset < items.length; offset += 64) {
        check();
        const batch = items.slice(offset, offset + 64);
        for (const item of batch)
          if (item.kind !== "resume" && redact(item.text) !== item.text)
            throw new Error("Protected input cannot be persisted.");
        session.appendTranscript(
          d.transcripts,
          generation,
          {
            messages: batch
              .filter((i) => i.kind !== "resume")
              .map((item) => ({
                role: "user" as const,
                content: item.text,
                sourceInbox: { seq: item.seq, messageId: item.messageId },
              })),
            inboxAfter: batch.at(-1)?.seq,
          },
          signal,
        );
        check();
        texts.push(...batch.filter((i) => i.kind !== "resume"));
      }
      return texts;
    };
    // A message of the user's stays pending until Claude Code says a reply took it in.
    const send = (content: SDKUserMessage["message"]["content"], seq?: number) => {
      const uuid = inputs.push(content);
      if (uuid && seq !== undefined) pending.set(uuid, seq);
    };
    const call: LocaldotCall = (name, args, callSignal) => {
      if (!current()) return Promise.resolve(inactive());
      const paused = () =>
        toCallToolResult({
          ok: false,
          pause: true,
          content: [text("Task paused before this call started.")],
        });
      if (!admitting || session.safetyPause) return Promise.resolve(paused());
      // The newest full screenshot dot had seen when it chose this action.
      const seen = basis;
      inFlight++;
      const work = calls
        .then(async (): Promise<McpCallResult> => {
          if (!current()) return inactive();
          if (!admitting || session.safetyPause) return paused();
          if (!isToolName(name) && !session.connectors.get(name))
            return { isError: true, content: [text("Only localDot's tools are available.")] };
          const steps = (args as { steps?: unknown } | null)?.steps;
          if (name === "computer" && Array.isArray(steps) && steps.length > MAX_BATCH_STEPS)
            return {
              isError: true,
              content: [text(`A batch takes at most ${MAX_BATCH_STEPS} steps; split it in two.`)],
            };
          let toolInput = args;
          if (
            (name === "computer" || name === "browser_act") &&
            typeof args === "object" &&
            args !== null &&
            !Array.isArray(args)
          ) {
            const { basedOn: _ignored, ...rest } = args as Record<string, unknown>;
            toolInput = { ...rest, basedOn: seen };
          }
          refusals = 0;
          if (!acting) {
            acting = true;
            guarded("agent.state", { state: "acting" });
          }
          const out = await d.dispatch(
            session,
            generation,
            name,
            `claude-${ulid()}`,
            toolInput,
            AbortSignal.any([signal, callSignal]),
          );
          if (!current()) return inactive();
          for (const part of out.content)
            if (part.type === "image" && !part.region) returned = part.frameId;
          if (!session.safetyPause) {
            if (name === "done" && out.ok && out.final) {
              finish(pending.size ? { kind: "completed", pending: true } : { kind: "done" });
              return inactive();
            }
            if (out.final) {
              finish({ kind: "done" });
              return inactive();
            }
          }
          completedCalls++;
          // A useful nonterminal result (including an external wait) resets the consecutive
          // no-tool nudge count. Refusals and failed/cancelled work cannot prolong a loop.
          if (out.ok && !out.pause && !out.cancelled) nudged = false;
          return toCallToolResult(out);
        })
        .catch(() => {
          if (current()) finish({ kind: "failed", message: "A localDot tool could not finish." });
          return inactive();
        })
        .finally(() => {
          inFlight--;
          if (inFlight) return;
          const waiters = [...settledWaiters];
          settledWaiters.clear();
          for (const wake of waiters) wake();
        });
      calls = work;
      return work;
    };
    // Claude Code refused the model's call to a tool that is not localDot's: nothing ran. Show it,
    // tell the model to use localDot's tools and go on, unless it keeps asking.
    const refused = (tools: string[]) => {
      const note = `Claude asked for ${toolList(tools)}, which isn't one of localDot's tools, and Claude Code refused it.`;
      console.warn(
        `claude code: refused Claude's call to ${tools.join(", ")} (task ${session.id})`,
      );
      const step = ulid();
      try {
        if (current()) {
          session.append("step.start", { kind: "think" }, step);
          session.append("tool.start", { tool: "claude-code.disabled", title: note }, step);
          session.append("tool.end", { ok: false }, step);
          session.append("step.end", { status: "blocked", note }, step);
        }
      } catch {
        finish({ kind: "failed", message: "The Claude Code task could not record an event." });
        return;
      }
      if (++refusals >= MAX_REFUSALS)
        finish({ kind: "violation", what: "refused", tool: tools[0] ?? UNNAMED_TOOL });
      else send(unavailable(tools));
    };
    const onSignal = (event: ClaudeSignal) => {
      if (event.kind === "started") clearTimeout(startupTimer);
      else if (event.kind === "turn") {
        basis = returned;
        acting = false;
      } else if (event.kind === "offered") finish(event);
      else if (event.kind === "refused") refused(event.tools);
      else if (event.kind === "violation") finish(event);
      else if (event.kind === "consumed")
        for (const uuid of event.uuids) {
          const seq = pending.get(uuid);
          if (seq === undefined) continue;
          pending.delete(uuid);
          session.heard(seq);
        }
      else if (event.kind === "error") {
        if (SIGNED_OUT.has(event.error)) finish({ kind: "signed_out" });
        else if (
          event.error === "billing_error" ||
          (event.error === "rate_limit" && mapper.limitReached)
        )
          finish({ kind: "plan_limit", detail: event.detail });
        else if (event.error === "model_not_found" || event.error === "invalid_request")
          finish({
            kind: "failed",
            message: "Claude Code can't use this model. Choose another in Settings.",
          });
        else if (event.error !== "max_output_tokens")
          finish({ kind: "retry", message: "Claude is unavailable right now." });
      } else if (event.kind === "result") {
        if (!event.ok) {
          finish({ kind: "retry", message: "Claude Code couldn't finish that step." });
          return;
        }
        if (event.queued) return;
        if (!nudged) {
          nudged = true;
          send(NUDGE);
          return;
        }
        finish({ kind: "completed", pending: false });
      }
    };
    const mapper = new ClaudeCodeEventMapper({ append: guarded, said }, redact, model);
    const inboxLoop = async () => {
      while (current()) {
        const batch = await session.inbox(session.delivered, heartbeatMs, signal, generation);
        if (!current()) return;
        for (const item of persist(batch.items)) {
          check();
          nudged = false;
          send(redact(item.text), item.seq);
        }
      }
    };
    const startup = (async () => {
      check();
      await session.prepareScreens(generation);
      check();
      if (session.safetyPause) throw new Error("Startup is fenced by Pause.");
      let launch: ClaudeCodeLaunch;
      try {
        launch = await d.launch();
      } catch (cause) {
        if (!(cause instanceof ClaudeCodeUnavailable)) throw cause;
        finish(
          cause.status.state === "signed_out"
            ? { kind: "signed_out" }
            : { kind: "failed", message: cause.message },
        );
        return;
      }
      check();
      mapper.plan = launch.plan;
      session.restoreDelivered(d.transcripts);
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
      const unread = await session.inbox(session.delivered, 0, signal, generation);
      check();
      const initial = persist(unread.items);
      const prompt = recap
        ? this.#recap(session, redact, suffix)
        : redact(
            [earlierRecord(session.earlier), session.task, ...initial.map((i) => i.text)]
              .filter((part) => part !== undefined)
              .join("\n\n"),
          );
      if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES)
        throw new Error("The task input is too large.");
      const observation = await d.observe(session, generation, signal);
      check();
      if (session.safetyPause) throw new Error("Startup is fenced by Pause.");
      if (
        observation.full !== true ||
        !ULID_PATTERN.test(observation.frameId) ||
        !Buffer.isBuffer(observation.png) ||
        observation.png.length > 4 * 1024 * 1024 ||
        !observation.png.subarray(0, 8).equals(PNG_HEADER)
      )
        throw new Error("Invalid full screenshot.");
      basis = returned = observation.frameId;
      session.tainted = true;
      send([
        text(prompt),
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: observation.png.toString("base64"),
          },
        },
      ]);
      session.heard(session.delivered);
      const spawn = (options: SpawnOptions): SpawnedProcess => {
        if (fenced) throw new Error("The Claude Code run was retired.");
        const child = d.spawn(options, session);
        const exited = new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode) return resolve();
          child.once("exit", () => resolve());
          child.once("error", () => resolve());
        });
        children.add({ child, exited });
        void exited.then(() => {
          if (!fenced) finish({ kind: "crashed" });
        });
        return child;
      };
      query = d.query({
        prompt: inputs,
        options: claudeCodeOptions({
          launch,
          model,
          modelOptions: options,
          instructions: redact(d.instructions(session)),
          server: localdotServer(call, !!session.research, () =>
            connectorDescriptors(session.connectors),
          ),
          disallowed,
          abort,
          spawn,
        }),
      });
      if (fenced) query.close();
      const stream = query;
      consuming = (async () => {
        try {
          for await (const message of stream) {
            if (!current()) break;
            for (const event of mapper.handle(message)) {
              onSignal(event);
              if (!current()) break;
            }
          }
          if (!fenced) finish({ kind: "crashed" });
        } catch {
          if (!fenced) finish({ kind: "crashed" });
        }
      })();
      void inboxLoop().catch(() => {
        if (current()) finish({ kind: "failed", message: "The task input could not be saved." });
      });
    })().catch(() => {
      if (result) return;
      if (!current()) loss();
      else finish({ kind: "failed", message: "Claude Code could not start." });
    });
    const outcome = await completion.promise;
    fence();
    clearTimeout(startupTimer);
    clearInterval(heartbeat);
    signal.removeEventListener("abort", loss);
    removeControlObserver();
    const exitMs = d.exitMs ?? 2500;
    const cleanup = (async () => {
      await startup;
      for (const { child, exited } of children) {
        try {
          await within(exited, exitMs);
        } catch {
          if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
          await within(exited, exitMs);
        }
      }
      await within(consuming, exitMs).catch(() => {});
      await Promise.all([calls.catch(() => {}), session.toolsSettled()]);
    })();
    try {
      await within(this.#retirement.track(session.id, cleanup), exitMs * 2 + 2000);
      owner.retire();
      retired.resolve();
    } catch {
      retired.reject(new ClaudeCodeCleanupError());
      this.#blocked.add(session.id);
      throw new ClaudeCodeCleanupError();
    }
    return outcome;
  }
}
