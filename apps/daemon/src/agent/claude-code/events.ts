import {
  type PremiumSpeed,
  type SubscriptionUsageData,
  type SubscriptionWindow,
  ulid,
} from "@localdot/protocol";
import { servedSpeed } from "@localdot/providers";
import { z } from "zod";
import type { Redactor } from "../redact.ts";
import { LOCALDOT_TOOLS } from "./options.ts";

export const CLAUDE_CODE_ROUTE = "claude-code";
export type Violation = "foreign_tool" | "sub_agent";
export type ClaudeSignal =
  | { kind: "started" }
  | { kind: "turn" }
  | { kind: "violation"; what: Violation }
  | { kind: "error"; error: string; detail?: string }
  | { kind: "consumed"; uuids: string[] }
  | { kind: "result"; ok: boolean; queued: boolean };
export interface MapperSink {
  append(type: string, data: Record<string, unknown>): void;
  // A finished reply of dot's, already redacted, for the task's history.
  said(text: string): void;
}

const Init = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  tools: z.array(z.string()),
});
const Retry = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  attempt: z.number().int().positive(),
  retry_delay_ms: z.number().nonnegative(),
  error_status: z.number().int().nullish(),
});
const Usage = z.looseObject({
  input_tokens: z.number().int().nonnegative().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  speed: z.string().nullish(),
});

const MessageStart = z.looseObject({
  type: z.literal("message_start"),
  message: z.looseObject({ model: z.string().optional(), usage: Usage.optional() }),
});
const BlockStart = z.looseObject({
  type: z.literal("content_block_start"),
  index: z.number().int(),
  content_block: z.looseObject({
    type: z.string(),
    name: z.string().optional(),
    text: z.string().optional(),
  }),
});
const BlockDelta = z.looseObject({
  type: z.literal("content_block_delta"),
  index: z.number().int(),
  delta: z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
  }),
});
const BlockStop = z.looseObject({ type: z.literal("content_block_stop"), index: z.number().int() });
const MessageDelta = z.looseObject({ type: z.literal("message_delta"), usage: Usage.optional() });
const Consumed = z.looseObject({
  user_message_uuid: z.string().optional(),
  user_message_uuids: z.array(z.string()).optional(),
});
const StreamEvent = Consumed.extend({
  type: z.literal("stream_event"),
  parent_tool_use_id: z.string().nullish(),
  event: z.looseObject({ type: z.string() }),
});
const Assistant = Consumed.extend({
  type: z.literal("assistant"),
  parent_tool_use_id: z.string().nullish(),
  error: z.string().optional(),
  message: z.looseObject({
    content: z.array(
      z.looseObject({ type: z.string(), name: z.string().optional(), text: z.string().optional() }),
    ),
  }),
});
const User = z.looseObject({ type: z.literal("user"), parent_tool_use_id: z.string().nullish() });
const Result = Consumed.extend({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  queued_turn_count: z.number().int().nonnegative().optional(),
});
const RateLimit = z.looseObject({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({
    status: z.enum(["allowed", "allowed_warning", "rejected"]),
    resetsAt: z.number().nonnegative().optional(),
    rateLimitType: z.string().optional(),
    utilization: z.number().optional(),
  }),
});
const AuthStatus = z.looseObject({ type: z.literal("auth_status"), error: z.string().optional() });

// Claude Code's plan windows: the five-hour session and the weekly limits.
const WINDOWS: Record<string, { window: SubscriptionWindow["window"]; minutes: number }> = {
  five_hour: { window: "primary", minutes: 300 },
  seven_day: { window: "secondary", minutes: 10_080 },
  seven_day_opus: { window: "secondary", minutes: 10_080 },
  seven_day_sonnet: { window: "secondary", minutes: 10_080 },
};

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
  return `${text.slice(0, end)}…`;
}

interface Block {
  kind: "text" | "thinking";
  messageId: string;
  stream: ReturnType<NonNullable<Redactor["stream"]>> | undefined;
  raw: string;
  said: string;
}

// Claude Code's stream as dot's own events. Only localDot's tools may appear, and only on the main
// thread; anything else is reported for the driver to stop on.
export class ClaudeCodeEventMapper {
  readonly #sink: MapperSink;
  readonly #redact: Redactor;
  readonly #model: string;
  // The user's Claude plan, as Claude Code's status names it.
  plan: string | undefined;
  readonly #blocks = new Map<number, Block>();
  readonly #windows = new Map<SubscriptionWindow["window"], SubscriptionWindow>();
  #limited = false;
  #usage: string | undefined;
  #input = 0;
  #speed: PremiumSpeed | undefined;
  #callModel: string;
  constructor(sink: MapperSink, redact: Redactor, model: string) {
    this.#sink = sink;
    this.#redact = redact;
    this.#model = model;
    this.#callModel = model;
  }
  get limitReached(): boolean {
    return this.#limited;
  }
  handle(message: unknown): ClaudeSignal[] {
    const type = (message as { type?: unknown } | null)?.type;
    if (type === "stream_event") return this.#stream(message);
    if (type === "assistant") return this.#assistant(message);
    if (type === "user") {
      const user = User.safeParse(message);
      return user.success && user.data.parent_tool_use_id
        ? [{ kind: "violation", what: "sub_agent" }]
        : [];
    }
    if (type === "result") {
      const result = Result.safeParse(message);
      if (!result.success) return [{ kind: "result", ok: false, queued: false }];
      return [
        ...this.#consumed(result.data),
        {
          kind: "result",
          ok: result.data.subtype === "success" && !result.data.is_error,
          queued: (result.data.queued_turn_count ?? 0) > 0,
        },
      ];
    }
    if (type === "rate_limit_event") {
      this.#rateLimit(message);
      return [];
    }
    if (type === "auth_status") {
      const auth = AuthStatus.safeParse(message);
      return auth.success && auth.data.error
        ? [{ kind: "error", error: "authentication_failed" }]
        : [];
    }
    if (type === "system") {
      const init = Init.safeParse(message);
      if (init.success)
        return init.data.tools.every((tool) => LOCALDOT_TOOLS.includes(tool))
          ? [{ kind: "started" }]
          : [{ kind: "violation", what: "foreign_tool" }];
      const retry = Retry.safeParse(message);
      if (retry.success)
        this.#sink.append("model.retry", {
          role: "main",
          attempt: retry.data.attempt,
          waitMs: Math.round(retry.data.retry_delay_ms),
          ...(retry.data.error_status ? { status: retry.data.error_status } : {}),
          message: "Claude is busy. Trying again.",
        });
    }
    return [];
  }
  #consumed(value: z.infer<typeof Consumed>): ClaudeSignal[] {
    const uuids = [
      ...(value.user_message_uuids ?? []),
      ...(value.user_message_uuid ? [value.user_message_uuid] : []),
    ];
    return uuids.length ? [{ kind: "consumed", uuids }] : [];
  }
  #assistant(message: unknown): ClaudeSignal[] {
    const parsed = Assistant.safeParse(message);
    if (!parsed.success) return [];
    if (parsed.data.parent_tool_use_id) return [{ kind: "violation", what: "sub_agent" }];
    if (
      parsed.data.message.content.some(
        (block) =>
          (block.type === "tool_use" || block.type === "server_tool_use") &&
          !LOCALDOT_TOOLS.includes(block.name ?? ""),
      )
    )
      return [{ kind: "violation", what: "foreign_tool" }];
    return [
      ...this.#consumed(parsed.data),
      ...(parsed.data.error
        ? [
            {
              kind: "error" as const,
              error: parsed.data.error,
              detail: clip(
                this.#redact(
                  parsed.data.message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text ?? "")
                    .join(" "),
                ),
                200,
              ),
            },
          ]
        : []),
    ];
  }
  #stream(message: unknown): ClaudeSignal[] {
    const parsed = StreamEvent.safeParse(message);
    if (!parsed.success) return [];
    if (parsed.data.parent_tool_use_id) return [{ kind: "violation", what: "sub_agent" }];
    return [...this.#consumed(parsed.data), ...this.#event(parsed.data.event)];
  }
  #event(event: z.infer<typeof StreamEvent>["event"]): ClaudeSignal[] {
    if (event.type === "message_start") {
      const start = MessageStart.safeParse(event);
      const usage = start.success ? start.data.message.usage : undefined;
      this.#input =
        (usage?.input_tokens ?? 0) +
        (usage?.cache_read_input_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0);
      this.#speed = servedSpeed(usage?.speed);
      const model = start.success ? start.data.message.model : undefined;
      this.#callModel = model && model.length <= 128 ? model : this.#model;
      this.#sink.append("agent.state", { state: "thinking" });
      return [{ kind: "turn" }];
    }
    if (event.type === "content_block_start") {
      const start = BlockStart.safeParse(event);
      if (!start.success) return [];
      const block = start.data.content_block;
      if (block.type === "tool_use" || block.type === "server_tool_use")
        return LOCALDOT_TOOLS.includes(block.name ?? "")
          ? []
          : [{ kind: "violation", what: "foreign_tool" }];
      if (block.type === "text" || block.type === "thinking")
        this.#blocks.set(start.data.index, {
          kind: block.type,
          messageId: ulid(),
          stream: this.#redact.stream?.(),
          raw: "",
          said: "",
        });
      return [];
    }
    if (event.type === "content_block_delta") {
      const delta = BlockDelta.safeParse(event);
      const block = delta.success ? this.#blocks.get(delta.data.index) : undefined;
      if (!delta.success || !block) return [];
      const text = block.kind === "text" ? delta.data.delta.text : delta.data.delta.thinking;
      if (text) this.#push(block, text, false);
      return [];
    }
    if (event.type === "content_block_stop") {
      const stop = BlockStop.safeParse(event);
      const block = stop.success ? this.#blocks.get(stop.data.index) : undefined;
      if (!stop.success || !block) return [];
      this.#blocks.delete(stop.data.index);
      this.#push(block, "", true);
      const said = clip(block.said.trim(), 20_000);
      if (block.kind === "text" && said) {
        this.#sink.append("message.assistant", { messageId: block.messageId, text: said });
        this.#sink.said(said);
      }
      return [];
    }
    if (event.type === "message_delta") {
      const delta = MessageDelta.safeParse(event);
      if (!delta.success) return [];
      const reported = delta.data.usage?.speed;
      const speed = reported == null ? this.#speed : servedSpeed(reported);
      this.#sink.append("model.usage", {
        role: "main",
        route: CLAUDE_CODE_ROUTE,
        model: this.#callModel,
        inputTokens: this.#input,
        outputTokens: delta.data.usage?.output_tokens ?? 0,
        ...(speed ? { speed } : {}),
      });
    }
    return [];
  }
  #push(block: Block, text: string, final: boolean): void {
    let ready: string;
    if (block.stream) {
      const chunks = text ? block.stream.push({ stream: "stdout", chunk: text }) : [];
      if (final) chunks.push(...block.stream.finish());
      ready = chunks.map((chunk) => chunk.chunk).join("");
    } else {
      block.raw += text;
      ready = final ? this.#redact(block.raw) : "";
      if (final) block.raw = "";
    }
    block.said += ready;
    for (let at = 0; at < ready.length; at += 4000) {
      const part = ready.slice(at, at + 4000);
      this.#sink.append(block.kind === "text" ? "message.delta" : "thought.delta", {
        ...(block.kind === "text" ? { messageId: block.messageId } : {}),
        text: part,
      });
    }
  }
  #rateLimit(message: unknown): void {
    const parsed = RateLimit.safeParse(message);
    if (!parsed.success) return;
    const info = parsed.data.rate_limit_info;
    const window = WINDOWS[info.rateLimitType ?? ""];
    this.#limited = info.status === "rejected";
    // Seconds since the epoch, as the plan windows are shown; a millisecond time is converted.
    const resets =
      info.resetsAt === undefined
        ? undefined
        : Math.round(info.resetsAt > 1e12 ? info.resetsAt / 1000 : info.resetsAt);
    if (window && info.utilization !== undefined && Number.isFinite(info.utilization)) {
      // Claude Code reports how much of the window is used as a fraction.
      const used = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
      if (used >= 0 && used <= 100)
        this.#windows.set(window.window, {
          window: window.window,
          usedPercent: Math.round(used * 10) / 10,
          windowMinutes: window.minutes,
          ...(resets !== undefined && Number.isSafeInteger(resets) ? { resetsAt: resets } : {}),
        });
    }
    const data: SubscriptionUsageData = {
      provider: "claude-code",
      ...(this.plan ? { plan: this.plan } : {}),
      windows: [...this.#windows.values()].sort((a, b) => a.window.localeCompare(b.window)),
      limitReached: this.#limited,
    };
    const key = JSON.stringify(data);
    if (key === this.#usage) return;
    this.#usage = key;
    this.#sink.append("subscription.usage", data);
  }
}
