import type { ClientKind } from "@localdot/protocol";

// A streamed answer from each first-class bearer provider, in its own wire format and its own
// usage dialect, as keyd's listener relays it (no network in a test). The same usage, 1,200 input
// and 80 output tokens, sits where each provider puts it: xAI's Responses API in
// `response.completed`, Mistral, DeepSeek and OpenRouter in the last chunk's `usage`, and Groq in
// the last chunk's `x_groq.usage` (Part 4a's meter reads the same places, with this amendment).
export interface ProviderStream {
  client: Extract<ClientKind, "xai" | "mistral" | "deepseek" | "groq" | "openrouter">;
  model: string;
  // The operation under the route, and the output-cap field the official package sends: the one
  // keyd's preset for the provider writes its cap into (P5a-R31).
  path: string;
  capField: string;
  // Whether the package asks for usage in the stream (stream_options.include_usage); the others
  // report it unasked.
  asksForUsage: boolean;
  sse: string;
}

export const STREAM_USAGE = { inputTokens: 1200, outputTokens: 80 } as const;

const usage = {
  prompt_tokens: 1200,
  completion_tokens: 80,
  total_tokens: 1280,
};

function events(list: Record<string, unknown>[], named: boolean): string {
  return list
    .map((e) => `${named ? `event: ${String(e.type)}\n` : ""}data: ${JSON.stringify(e)}\n\n`)
    .join("");
}

function chat(last: Record<string, unknown>): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return `${events(
    [chunk({ role: "assistant", content: "ok" }, null), { ...chunk({}, "stop"), ...last }],
    false,
  )}data: [DONE]\n\n`;
}

const message = (status: string, text: string) => ({
  type: "message",
  id: "msg_1",
  role: "assistant",
  status,
  content: text ? [{ type: "output_text", text, annotations: [] }] : [],
});
const response = {
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "grok-4.3",
  output: [],
};

export const FIRST_CLASS_STREAMS: readonly ProviderStream[] = [
  {
    client: "xai",
    model: "grok-4.3",
    path: "responses",
    capField: "max_output_tokens",
    asksForUsage: false,
    sse: events(
      [
        {
          type: "response.created",
          response: { ...response, status: "in_progress" },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: message("in_progress", ""),
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "ok",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: message("completed", "ok"),
        },
        {
          type: "response.completed",
          response: {
            ...response,
            status: "completed",
            output: [message("completed", "ok")],
            usage: {
              input_tokens: 1200,
              output_tokens: 80,
              total_tokens: 1280,
            },
          },
        },
      ],
      true,
    ),
  },
  {
    client: "mistral",
    model: "mistral-medium-3",
    path: "chat/completions",
    capField: "max_tokens",
    asksForUsage: false,
    sse: chat({ usage }),
  },
  {
    client: "deepseek",
    model: "deepseek-chat",
    path: "chat/completions",
    capField: "max_tokens",
    asksForUsage: true,
    sse: chat({
      usage: {
        ...usage,
        prompt_cache_hit_tokens: 1000,
        prompt_cache_miss_tokens: 200,
      },
    }),
  },
  {
    client: "groq",
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    path: "chat/completions",
    capField: "max_tokens",
    asksForUsage: false,
    sse: chat({ x_groq: { id: "req_1", usage } }),
  },
  {
    client: "openrouter",
    model: "google/gemini-3.6-flash",
    path: "chat/completions",
    capField: "max_tokens",
    asksForUsage: true,
    sse: chat({ usage: { ...usage, cost: 0.0042 } }),
  },
];

// A Responses API answer from a reasoning model, as OpenAI, Azure and xAI stream it with
// store: false (P5a-R33): the reasoning item comes back with its encrypted content, which the next
// turn sends back in place of a reference to a stored response.
const reasoningItem = {
  type: "reasoning",
  id: "rs_1",
  summary: [],
  status: "completed",
  encrypted_content: "encrypted-reasoning-1",
};
const answer = {
  ...message("completed", ""),
  content: [{ type: "output_text", text: "ok", annotations: [], logprobs: [] }],
};
export const ENCRYPTED_REASONING = reasoningItem.encrypted_content;
export const RESPONSES_WITH_REASONING = events(
  [
    {
      type: "response.created",
      response: { ...response, status: "in_progress" },
      sequence_number: 0,
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...reasoningItem, encrypted_content: null },
      sequence_number: 1,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: reasoningItem,
      sequence_number: 2,
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: message("in_progress", ""),
      sequence_number: 3,
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 1,
      content_index: 0,
      delta: "ok",
      logprobs: [],
      sequence_number: 4,
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: answer,
      sequence_number: 5,
    },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        incomplete_details: null,
        output: [reasoningItem, answer],
        usage: {
          input_tokens: 1200,
          output_tokens: 80,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 30 },
        },
      },
      sequence_number: 6,
    },
  ],
  true,
);
