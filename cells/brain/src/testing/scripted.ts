import type {
  BootConfig,
  ComputerAction,
  InboxItem,
  ModelBinding,
  ToolResult,
  TranscriptMessage,
} from "@localdot/protocol";
import { DEFAULT_AGENT_LIMITS, TranscriptAppend, ulid } from "@localdot/protocol";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ToolClient } from "../tool-client.ts";

type Chunk = Record<string, unknown>;
export type Turn = Chunk[] | Error | (() => Chunk[] | Error);

const usage = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};
const finish = (reason: "tool-calls" | "stop") => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});

export const call = (toolName: string, input: unknown): Turn => [
  {
    type: "tool-call",
    toolCallId: `call-${ulid()}`,
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];
export const calls = (...list: [string, unknown][]): Turn => [
  ...list.map(([toolName, input]) => ({
    type: "tool-call",
    toolCallId: `call-${ulid()}`,
    toolName,
    input: JSON.stringify(input),
  })),
  finish("tool-calls"),
];
export const say = (text: string): Turn => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  finish("stop"),
];

// A model that plays its turns in order and records every prompt it was sent.
export function scriptedModel(turns: Turn[]) {
  const prompts: unknown[] = [];
  const next = () => {
    const turn = turns.shift() ?? say("(out of script)");
    const resolved = typeof turn === "function" ? turn() : turn;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      return {
        stream: simulateReadableStream({
          chunks: next() as never[],
          // These are scripted model turns, not latency tests. Keep their async streaming
          // contract without scheduling a real timer for every chunk on busy CI runners.
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
    // generateText (the summaries): the turn's text deltas as one text part.
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const text = next()
        .filter((c) => c.type === "text-delta")
        .map((c) => String(c.delta))
        .join("");
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  return { model, prompts };
}

export const SURROGATE = "ld_llm_0123456789abcdefghijkl_abcdef";
export const PROXY_TOKEN = "p".repeat(43);

export function binding(over: Partial<ModelBinding> = {}): ModelBinding {
  return {
    route: "anthropic",
    client: "anthropic",
    model: "claude-sonnet-5-5",
    surrogate: SURROGATE,
    computer: "anthropic-toolset",
    coords: "pixels",
    vision: true,
    reasoning: false,
    contextTokens: 200_000,
    maxOutputTokens: 4096,
    ...over,
  };
}

export function bootConfig(over: Partial<BootConfig> = {}): BootConfig {
  return {
    sessionId: ulid(),
    task: "Find the weather in Lyon",
    models: { main: binding() },
    proxy: { url: "http://172.30.4.10:3128", token: PROXY_TOKEN },
    memory: { user: "# About the user\n", memory: "# Memory\n" },
    skills: [],
    limits: DEFAULT_AGENT_LIMITS,
    resume: false,
    inboxAfter: 0,
    ...over,
  };
}

// The daemon's tool API, faked: screenshots get fresh frame ids, other tools answer from `answer`.
export function fakeApi(
  answer: (name: string, input: unknown) => ToolResult | undefined = () => undefined,
) {
  const toolCalls: { name: string; input: unknown }[] = [];
  const callIds: string[] = [];
  const catalogCalls: { name: string; input: unknown }[] = [];
  const transcript: TranscriptMessage[] = [];
  const inbox: InboxItem[] = [];
  let stopped = false;
  let acknowledged = 0;
  const fetched = new Set<number>();
  const api = {
    tool: async (name: string, id: string, input: unknown): Promise<ToolResult> => {
      // Harness filesystem discovery is tracked separately from model-requested actions.
      if (id.startsWith("skill-") && name === "files") {
        catalogCalls.push({ name, input });
        const request = input as { op: string; path: string };
        const custom = answer(name, input);
        if (custom) return custom;
        return request.op === "list"
          ? {
              ok: true,
              content: [],
              fileList: { path: request.path, entries: [], truncated: false },
            }
          : { ok: false, content: [], fileError: "not_found" };
      }
      toolCalls.push({ name, input });
      callIds.push(id);
      const custom = answer(name, input);
      if (custom) return custom;
      if (name === "computer") {
        const a = input as ComputerAction;
        if (a.action === "cursor_position")
          return {
            ok: true,
            content: [{ type: "text", text: "The cursor is at (640, 400)." }],
          };
        return {
          ok: true,
          content: [
            {
              type: "image",
              frameId: ulid(),
              mediaType: "image/png",
              data: "iVBORw0KGgo=",
            },
          ],
        };
      }
      if (name === "done")
        return {
          ok: true,
          final: true,
          content: [{ type: "text", text: "Task finished." }],
        };
      return { ok: true, content: [{ type: "text", text: `${name} ok` }] };
    },
    transcript: async () => structuredClone(transcript),
    inbox: async (after: number) => {
      const items = inbox.filter((i) => i.seq > after);
      for (const item of items) fetched.add(item.seq);
      return { items: structuredClone(items), stopped };
    },
    control: (async () => ({ revision: 0 })) as ToolClient["control"],
    brief: async () => {},
    appendTranscript: async (
      messages: TranscriptMessage[],
      inboxAfter?: number,
      signal?: AbortSignal,
    ) => {
      signal?.throwIfAborted();
      if (stopped) throw new Error("fixture stopped");
      const request = TranscriptAppend.parse({
        messages,
        ...(inboxAfter === undefined ? {} : { inboxAfter }),
      });
      const next = structuredClone(transcript);
      for (const message of request.messages) {
        const previous =
          message.sourceInbox &&
          next.find((m) => m.sourceInbox?.messageId === message.sourceInbox?.messageId);
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(message))
            throw new Error("conflicting inbox replay");
        } else next.push(message);
      }
      if (inboxAfter !== undefined && inboxAfter > acknowledged) {
        if (!fetched.has(inboxAfter)) throw new Error("unseen inbox acknowledgement");
        for (const item of inbox.filter((i) => i.seq > acknowledged && i.seq <= inboxAfter)) {
          if (
            !fetched.has(item.seq) ||
            (item.kind !== "resume" &&
              !next.some(
                (m) =>
                  m.role === "user" &&
                  m.sourceInbox?.seq === item.seq &&
                  m.sourceInbox.messageId === item.messageId &&
                  m.content === item.text,
              ))
          )
            throw new Error("undurable inbox acknowledgement");
        }
      }
      transcript.splice(0, transcript.length, ...next);
      if (inboxAfter !== undefined) acknowledged = Math.max(acknowledged, inboxAfter);
    },
  };
  return {
    api,
    toolCalls,
    catalogCalls,
    callIds,
    transcript,
    inbox,
    get acknowledged() {
      return acknowledged;
    },
    stop: () => (stopped = true),
  };
}
