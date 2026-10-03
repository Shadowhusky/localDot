import {
  AgentMessageItem,
  type CodexTurnEpoch,
  codexErrorKind,
  ErrorNotification,
  ItemNotification,
  MCP_SERVER_NAME,
  McpToolCallItem,
  RateLimitsUpdated,
  TextDelta,
  TokenUsageUpdated,
  type Turn,
  TurnCompleted,
  TurnStarted,
  turnOutcome,
} from "@localdot/codex-harness";
import { ULID_PATTERN, ulid } from "@localdot/protocol";
import type { Redactor } from "../redact.ts";
import type { AgentSession, BrainGeneration } from "../session.ts";
import { cut } from "../tools/deps.ts";
import { type SubscriptionUsageData, subscriptionUsage } from "./usage.ts";

export type MapperSession = Pick<AgentSession, "append" | "isCurrent" | "controlHeld" | "abort">;
export type Violation = "command" | "file_applied" | "sub_agent" | "foreign_tool" | "builtin_tool";
export type MapperSignal =
  | { kind: "turn_started"; turnId: string }
  | { kind: "turn_completed"; turn: Turn }
  | { kind: "violation"; what: Violation; detail: string }
  | { kind: "usage"; data: SubscriptionUsageData };
export interface CodexEventMapperOptions {
  readonly session: MapperSession;
  readonly generation: BrainGeneration;
  readonly turn: CodexTurnEpoch;
  readonly isTurnCurrent: (epoch: CodexTurnEpoch) => boolean;
  readonly authGeneration: number;
  readonly currentAuthGeneration: () => number;
  readonly authSignal: AbortSignal;
  readonly signal: AbortSignal;
  readonly model: string;
  readonly mainThreadId: () => string | undefined;
  readonly redact: Redactor;
  readonly flushMs?: number;
  readonly onFailure?: () => void;
}
interface Item {
  messageId: string;
  phase: "commentary" | "final_answer";
  completed?: boolean;
}
interface Batch {
  itemId: string;
  kind: "message" | "thought";
  messageId?: string;
  stream?: ReturnType<NonNullable<Redactor["stream"]>>;
  ready: string;
  raw: string;
  held: number;
}
const SAFE_ERROR_KINDS = new Set([
  "unauthorized",
  "usageLimitExceeded",
  "serverOverloaded",
  "internalServerError",
  "rateLimitExceeded",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);
const VIOLATION_TEXT: Record<Violation, string> = {
  command: "Codex attempted a command outside localDot's tools.",
  file_applied: "Codex applied a file change outside localDot's tools.",
  sub_agent: "Codex attempted work outside the active task thread.",
  foreign_tool: "Codex attempted a tool from another server.",
  builtin_tool: "Codex attempted a built-in tool outside localDot's tools.",
};
function prefix(text: string, max: number): string {
  let end = Math.min(max, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
  return text.slice(0, end);
}
function bounded(text: string, max: number): string {
  const clipped = cut(text, max);
  return clipped.length <= max ? clipped : `${prefix(clipped, max - 1)}…`;
}
function synchronousFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  )
    Promise.resolve(value).catch(() => {});
  return false;
}

// One mapper belongs to one connection and explicit full-frame turn. Notifications never create
// a turn epoch or advance its basis; only the driver can submit a new image under new authority.
export class CodexEventMapper {
  readonly #opts: CodexEventMapperOptions;
  readonly #signal: AbortSignal;
  readonly #snapshot: { id: number; signal: AbortSignal; basis: string };
  #closed = false;
  #failure = false;
  #turnId: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #batch: Batch | undefined;
  #lastAssistant: string | undefined;
  #usage: string | undefined;
  #retries = 0;
  readonly #items = new Map<string, Item>();
  readonly #abort = () => this.close();
  constructor(opts: CodexEventMapperOptions) {
    this.#opts = Object.freeze({ ...opts });
    this.#snapshot = { id: opts.turn.id, signal: opts.turn.signal, basis: opts.turn.basisFrameId };
    this.#signal = AbortSignal.any([
      opts.signal,
      opts.authSignal,
      opts.generation.signal,
      opts.turn.signal,
      opts.session.abort.signal,
    ]);
    this.#signal.addEventListener("abort", this.#abort, { once: true });
    if (
      !Object.isFrozen(opts.turn) ||
      !Number.isSafeInteger(opts.turn.id) ||
      opts.turn.id <= 0 ||
      !new RegExp(ULID_PATTERN).test(opts.turn.basisFrameId) ||
      !Number.isSafeInteger(opts.authGeneration) ||
      opts.authGeneration < 0 ||
      !opts.model ||
      opts.model.length > 128 ||
      !this.#current()
    )
      this.close();
  }
  #current(): boolean {
    if (this.#closed || this.#signal.aborted) return false;
    const o = this.#opts;
    try {
      return (
        o.session.isCurrent(o.generation) &&
        !o.session.controlHeld &&
        o.currentAuthGeneration() === o.authGeneration &&
        o.turn.id === this.#snapshot.id &&
        o.turn.signal === this.#snapshot.signal &&
        o.turn.basisFrameId === this.#snapshot.basis &&
        synchronousFlag(o.isTurnCurrent(o.turn))
      );
    } catch {
      return false;
    }
  }
  #active(): boolean {
    if (this.#current()) return true;
    this.close();
    return false;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#batch = undefined;
    this.#items.clear();
    this.#signal.removeEventListener("abort", this.#abort);
  }
  #fail(): void {
    if (this.#failure) return;
    this.#failure = true;
    this.close();
    try {
      Promise.resolve(this.#opts.onFailure?.()).catch(() => {});
    } catch {
      /* ownership stays fenced */
    }
  }
  lastAssistantText(): string | undefined {
    return this.#lastAssistant;
  }
  #text(text: string, limit: number): string | undefined {
    const safe = bounded(this.#opts.redact(text), limit);
    return this.#active() ? safe : undefined;
  }
  #append(type: string, data: Record<string, unknown>): boolean {
    if (!this.#active()) return false;
    this.#opts.session.append(type, data);
    return this.#active();
  }
  #signalResult(signal: MapperSignal): MapperSignal[] {
    return this.#active() ? [signal] : [];
  }
  #violation(what: Violation): MapperSignal[] {
    if (!this.#active()) return [];
    this.close();
    return [{ kind: "violation", what, detail: VIOLATION_TEXT[what] }];
  }
  #item(id: string, phase: Item["phase"] = "final_answer"): Item {
    const existing = this.#items.get(id);
    if (existing) return existing;
    if (this.#items.size >= 256) throw new Error("Codex event capacity exceeded.");
    const item = { messageId: ulid(), phase };
    this.#items.set(id, item);
    return item;
  }
  #flush(final: boolean): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#active()) return;
    const batch = this.#batch;
    if (!batch) return;
    if (final) {
      if (batch.stream)
        batch.ready += batch.stream
          .finish()
          .map((p) => p.chunk)
          .join("");
      else batch.ready += this.#opts.redact(batch.raw);
      batch.raw = "";
    }
    while (batch.ready && this.#active()) {
      const part = prefix(batch.ready, batch.kind === "message" ? 4000 : 20000);
      batch.ready = batch.ready.slice(part.length);
      const safe = this.#text(part, batch.kind === "message" ? 4000 : 20000);
      if (safe === undefined) return;
      if (
        safe &&
        !this.#append(batch.kind === "message" ? "message.delta" : "thought.delta", {
          ...(batch.messageId ? { messageId: batch.messageId } : {}),
          text: safe,
        })
      )
        return;
    }
    if (final) this.#batch = undefined;
  }
  // An explicit item/turn boundary releases the redactor's protected tail. Timed flushes do not.
  flush(): void {
    try {
      this.#flush(true);
    } catch {
      this.#fail();
    }
  }
  #delta(itemId: string, kind: Batch["kind"], text: string, messageId?: string): void {
    if (this.#batch && (this.#batch.itemId !== itemId || this.#batch.kind !== kind))
      this.#flush(true);
    if (!this.#active()) return;
    this.#batch ??= {
      itemId,
      kind,
      ...(messageId ? { messageId } : {}),
      stream: this.#opts.redact.stream?.(),
      ready: "",
      raw: "",
      held: 0,
    };
    const batch = this.#batch;
    for (let at = 0; at < text.length && this.#active(); at += 4096) {
      const part = text.slice(at, at + 4096);
      if (batch.stream) {
        const ready = batch.stream
          .push({ stream: "stdout", chunk: part })
          .map((p) => p.chunk)
          .join("");
        batch.ready += ready;
        batch.held = ready ? 0 : batch.held + part.length;
      } else {
        batch.raw += part;
      }
      if (batch.held > 64 * 1024 || batch.raw.length > 64 * 1024)
        throw new Error("Codex event capacity exceeded.");
      if (batch.ready.length >= 32 * 1024) this.#flush(false);
    }
    if (!this.#active()) return;
    if ((this.#opts.flushMs ?? 100) === 0) this.#flush(false);
    else
      this.#timer ??= setTimeout(
        () => {
          try {
            this.#flush(false);
          } catch {
            this.#fail();
          }
        },
        Math.max(1, Math.min(1000, this.#opts.flushMs ?? 100)),
      );
  }
  handle(method: string, params: unknown): MapperSignal[] {
    if (!this.#active()) return [];
    try {
      return this.#handle(method, params);
    } catch {
      this.#fail();
      return [];
    }
  }
  #handle(method: string, params: unknown): MapperSignal[] {
    const main = this.#opts.mainThreadId();
    if (!main) return [];
    if (
      typeof params === "object" &&
      params !== null &&
      "threadId" in params &&
      typeof params.threadId === "string" &&
      params.threadId !== main
    )
      return this.#violation("sub_agent");
    if (method === "turn/started") {
      const p = TurnStarted.safeParse(params);
      if (!p.success || p.data.threadId !== main || p.data.turn.status !== "inProgress") return [];
      if (this.#turnId) return p.data.turn.id === this.#turnId ? [] : this.#violation("sub_agent");
      this.#turnId = p.data.turn.id;
      this.#retries = 0;
      if (!this.#append("agent.state", { state: "thinking" })) return [];
      return this.#signalResult({ kind: "turn_started", turnId: this.#turnId });
    }
    if (!this.#turnId) return [];
    if (method === "account/rateLimits/updated") {
      const parsed = RateLimitsUpdated.safeParse(params);
      if (!parsed.success) return [];
      const data = subscriptionUsage(parsed.data.rateLimits);
      if (!data) return [];
      const key = JSON.stringify(data);
      if (key !== this.#usage) {
        if (!this.#append("subscription.usage", data)) return [];
        this.#usage = key;
      }
      return this.#signalResult({ kind: "usage", data });
    }
    if (method === "turn/completed") {
      const p = TurnCompleted.safeParse(params);
      if (
        !p.success ||
        p.data.threadId !== main ||
        p.data.turn.id !== this.#turnId ||
        p.data.turn.status === "inProgress"
      )
        return [];
      this.#flush(true);
      if (!this.#active()) return [];
      const value = p.data.turn,
        outcome = turnOutcome(value),
        kind = codexErrorKind(value.error?.codexErrorInfo);
      const turn: Turn = {
        id: value.id,
        status: value.status,
        ...(value.error
          ? {
              error: {
                message: "message" in outcome ? outcome.message : "The ChatGPT turn ended.",
                ...(kind && SAFE_ERROR_KINDS.has(kind) ? { codexErrorInfo: kind } : {}),
              },
            }
          : {}),
      };
      const signals = this.#signalResult({ kind: "turn_completed", turn });
      this.close();
      return signals;
    }
    if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta") {
      const p = TextDelta.safeParse(params);
      if (!p.success || p.data.threadId !== main || p.data.turnId !== this.#turnId) return [];
      const item = this.#item(p.data.itemId),
        kind = method.includes("reasoning") || item.phase === "commentary" ? "thought" : "message";
      if (item.completed) return [];
      this.#delta(
        p.data.itemId,
        kind,
        p.data.delta,
        kind === "message" ? item.messageId : undefined,
      );
      return [];
    }
    if (method === "thread/tokenUsage/updated") {
      const p = TokenUsageUpdated.safeParse(params);
      if (!p.success || p.data.threadId !== main || p.data.turnId !== this.#turnId) return [];
      const u = p.data.tokenUsage.last,
        model = this.#text(this.#opts.model, 128);
      if (model !== undefined)
        this.#append("model.usage", {
          role: "main",
          route: "chatgpt",
          model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          reasoningTokens: u.reasoningOutputTokens,
        });
      return [];
    }
    if (method === "error") {
      const p = ErrorNotification.safeParse(params);
      if (
        !p.success ||
        p.data.threadId !== main ||
        p.data.turnId !== this.#turnId ||
        !p.data.willRetry
      )
        return [];
      this.#append("model.retry", {
        role: "main",
        attempt: ++this.#retries,
        waitMs: 0,
        message: "The ChatGPT connection is retrying.",
      });
      return [];
    }
    if (method !== "item/started" && method !== "item/completed") return [];
    const p = ItemNotification.safeParse(params);
    if (!p.success || p.data.threadId !== main || p.data.turnId !== this.#turnId) return [];
    const item = p.data.item,
      completed = method === "item/completed";
    if (item.type === "agentMessage") {
      const message = AgentMessageItem.safeParse(item);
      if (!message.success) return [];
      const m = this.#item(item.id, message.data.phase ?? "final_answer");
      if (m.completed) return [];
      if (completed) {
        m.completed = true;
        this.#flush(true);
        if (m.phase === "final_answer") {
          const text = this.#text(message.data.text, 20000);
          if (
            text !== undefined &&
            this.#append("message.assistant", { messageId: m.messageId, text })
          )
            this.#lastAssistant = text;
        }
      }
      return [];
    }
    if (item.type === "mcpToolCall") {
      const tool = McpToolCallItem.safeParse(item);
      if (!tool.success) return [];
      if (tool.data.server !== MCP_SERVER_NAME) return this.#violation("foreign_tool");
      this.#flush(true);
      this.#append("agent.state", { state: completed ? "thinking" : "acting" });
      return [];
    }
    if (completed)
      return item.type === "fileChange" && item.status === "completed"
        ? this.#violation("file_applied")
        : [];
    if (item.type === "commandExecution") return this.#violation("command");
    if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity")
      return this.#violation("sub_agent");
    if (["webSearch", "imageGeneration", "imageView", "dynamicToolCall"].includes(item.type))
      return this.#violation("builtin_tool");
    return [];
  }
}
