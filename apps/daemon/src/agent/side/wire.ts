import type { ModelBinding, ReasoningEffort } from "@localdot/protocol";
import type { fetch as undiciFetch } from "undici";
import { gatewayPost, ModelAnswerError, thinking } from "../safety/judge-model.ts";
import type { SideImage, SideResult, SideToolSpec } from "./tools.ts";

const OUTPUT_TOKENS = 1500;

export interface SideToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}
export type SideMessage =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly step: SideStep }
  | {
      readonly role: "tools";
      readonly results: readonly { readonly call: SideToolCall; readonly result: SideResult }[];
    };
export interface SideStep {
  readonly text: string;
  readonly calls: readonly SideToolCall[];
  // The provider's own record of its turn, sent back as it came: signed thinking must not change.
  readonly raw: unknown;
  readonly inputTokens: number;
  readonly outputTokens: number;
}
interface Call {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  read(reply: unknown): SideStep;
}

const parseArgs = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
};
const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);
const textOf = (parts: unknown, key = "text"): string =>
  Array.isArray(parts)
    ? parts
        .map((part) => (part as Record<string, unknown>)?.[key])
        .filter((text): text is string => typeof text === "string")
        .join("")
    : "";
const SHOWN_NEXT = "The picture that tool returned:";

function anthropicCall(
  b: ModelBinding,
  system: string,
  messages: readonly SideMessage[],
  tools: readonly SideToolSpec[],
  think: Record<string, unknown>,
): Call {
  const key = b.surrogate ?? "";
  const image = (shown: SideImage) => ({
    type: "image",
    source: { type: "base64", media_type: shown.mediaType, data: shown.data },
  });
  return {
    path: "messages",
    headers: {
      ...(b.client === "anthropic"
        ? { "x-api-key": key }
        : key
          ? { authorization: `Bearer ${key}` }
          : {}),
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: b.model,
      max_tokens: OUTPUT_TOKENS,
      ...think,
      system,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema,
      })),
      messages: messages.map((message) => {
        if (message.role === "user") return { role: "user", content: message.text };
        if (message.role === "assistant") return { role: "assistant", content: message.step.raw };
        return {
          role: "user",
          content: message.results.map(({ call, result }) => ({
            type: "tool_result",
            tool_use_id: call.id,
            ...(result.ok ? {} : { is_error: true }),
            content: [{ type: "text", text: result.text }, ...(result.images ?? []).map(image)],
          })),
        };
      }),
    },
    read: (reply) => {
      const { content, usage } = reply as {
        content?: { type?: string; id?: string; name?: string; input?: unknown }[];
        usage?: Record<string, unknown>;
      };
      return {
        text: textOf(content?.filter((block) => block.type === "text")),
        calls: (content ?? [])
          .filter((block) => block.type === "tool_use")
          .map((block) => ({
            id: String(block.id),
            name: String(block.name),
            input: block.input ?? {},
          })),
        raw: content ?? [],
        inputTokens:
          count(usage?.input_tokens) +
          count(usage?.cache_read_input_tokens) +
          count(usage?.cache_creation_input_tokens),
        outputTokens: count(usage?.output_tokens),
      };
    },
  };
}

function googleCall(
  b: ModelBinding,
  system: string,
  messages: readonly SideMessage[],
  tools: readonly SideToolSpec[],
  think: Record<string, unknown>,
): Call {
  return {
    path: `models/${b.model}:generateContent`,
    headers: { "x-goog-api-key": b.surrogate ?? "" },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      tools: [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.schema,
          })),
        },
      ],
      contents: messages.map((message) => {
        if (message.role === "user") return { role: "user", parts: [{ text: message.text }] };
        if (message.role === "assistant") return { role: "model", parts: message.step.raw };
        return {
          role: "user",
          parts: message.results.flatMap(({ call, result }) => [
            { functionResponse: { name: call.name, response: { output: result.text } } },
            ...(result.images ?? []).map((shown) => ({
              inlineData: { mimeType: shown.mediaType, data: shown.data },
            })),
          ]),
        };
      }),
      generationConfig: { maxOutputTokens: OUTPUT_TOKENS, ...think },
    },
    read: (reply) => {
      const { candidates, usageMetadata } = reply as {
        candidates?: { content?: { parts?: Record<string, unknown>[] } }[];
        usageMetadata?: Record<string, unknown>;
      };
      const parts = candidates?.[0]?.content?.parts ?? [];
      return {
        text: textOf(parts.filter((part) => !part.thought)),
        calls: parts.flatMap((part, at) => {
          const called = part.functionCall as { name?: string; args?: unknown } | undefined;
          return called
            ? [{ id: `call_${at}`, name: String(called.name), input: called.args ?? {} }]
            : [];
        }),
        raw: parts,
        inputTokens: count(usageMetadata?.promptTokenCount),
        outputTokens:
          count(usageMetadata?.candidatesTokenCount) + count(usageMetadata?.thoughtsTokenCount),
      };
    },
  };
}

function responsesCall(
  b: ModelBinding,
  system: string,
  messages: readonly SideMessage[],
  tools: readonly SideToolSpec[],
  think: Record<string, unknown>,
): Call {
  const key = b.surrogate ?? "";
  return {
    path: "responses",
    headers:
      b.client === "azure" ? { "api-key": key } : key ? { authorization: `Bearer ${key}` } : {},
    // As the brain asks it: Codex-backed endpoints refuse a bare string and an unstreamed reply.
    body: {
      model: b.model,
      instructions: system,
      tools: tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
        strict: false,
      })),
      input: messages.flatMap((message): unknown[] => {
        if (message.role === "user")
          return [{ role: "user", content: [{ type: "input_text", text: message.text }] }];
        if (message.role === "assistant")
          return [
            ...(message.step.text
              ? [
                  {
                    role: "assistant",
                    content: [{ type: "output_text", text: message.step.text }],
                  },
                ]
              : []),
            ...message.step.calls.map((call) => ({
              type: "function_call",
              call_id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.input),
            })),
          ];
        const pictures = message.results.flatMap(({ result }) => result.images ?? []);
        return [
          ...message.results.map(({ call, result }) => ({
            type: "function_call_output",
            call_id: call.id,
            output: result.text,
          })),
          ...(pictures.length
            ? [
                {
                  role: "user",
                  content: [
                    { type: "input_text", text: SHOWN_NEXT },
                    ...pictures.map((shown) => ({
                      type: "input_image",
                      image_url: `data:${shown.mediaType};base64,${shown.data}`,
                    })),
                  ],
                },
              ]
            : []),
        ];
      }),
      max_output_tokens: OUTPUT_TOKENS,
      store: false,
      stream: true,
      ...think,
    },
    read: (reply) => {
      const { output, usage } = reply as {
        output?: {
          type?: string;
          content?: unknown;
          call_id?: string;
          name?: string;
          arguments?: unknown;
        }[];
        usage?: Record<string, unknown>;
      };
      return {
        text: (output ?? [])
          .filter((item) => item.type === "message")
          .map((item) => textOf(item.content))
          .join(""),
        calls: (output ?? [])
          .filter((item) => item.type === "function_call")
          .map((item) => ({
            id: String(item.call_id),
            name: String(item.name),
            input: parseArgs(item.arguments),
          })),
        raw: output ?? [],
        inputTokens: count(usage?.input_tokens),
        outputTokens: count(usage?.output_tokens),
      };
    },
  };
}

function chatCall(
  b: ModelBinding,
  system: string,
  messages: readonly SideMessage[],
  tools: readonly SideToolSpec[],
  think: Record<string, unknown>,
): Call {
  const key = b.surrogate ?? "";
  return {
    path: "chat/completions",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: {
      model: b.model,
      max_tokens: OUTPUT_TOKENS,
      ...think,
      tools: tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.schema },
      })),
      messages: [
        { role: "system", content: system },
        ...messages.flatMap((message): unknown[] => {
          if (message.role === "user") return [{ role: "user", content: message.text }];
          if (message.role === "assistant") return [message.step.raw];
          const pictures = message.results.flatMap(({ result }) => result.images ?? []);
          return [
            ...message.results.map(({ call, result }) => ({
              role: "tool",
              tool_call_id: call.id,
              content: result.text,
            })),
            ...(pictures.length
              ? [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: SHOWN_NEXT },
                      ...pictures.map((shown) => ({
                        type: "image_url",
                        image_url: { url: `data:${shown.mediaType};base64,${shown.data}` },
                      })),
                    ],
                  },
                ]
              : []),
          ];
        }),
      ],
    },
    read: (reply) => {
      const { choices, usage } = reply as {
        choices?: {
          message?: {
            content?: unknown;
            tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
          };
        }[];
        usage?: Record<string, unknown>;
      };
      const message = choices?.[0]?.message;
      return {
        text: typeof message?.content === "string" ? message.content : textOf(message?.content),
        calls: (message?.tool_calls ?? []).map((call, at) => ({
          id: call.id ?? `call_${at}`,
          name: String(call.function?.name),
          input: parseArgs(call.function?.arguments),
        })),
        raw: { role: "assistant", content: "", ...message },
        inputTokens: count(usage?.prompt_tokens),
        outputTokens: count(usage?.completion_tokens),
      };
    },
  };
}

// One turn of a read-only conversation in the provider's own API, as the brain speaks it.
export function sideCall(
  b: ModelBinding,
  system: string,
  messages: readonly SideMessage[],
  tools: readonly SideToolSpec[],
  effort?: ReasoningEffort,
): Call {
  const think = thinking(b, effort);
  switch (b.client) {
    case "anthropic":
    case "anthropic-compatible":
      return anthropicCall(b, system, messages, tools, think);
    case "google":
      return googleCall(b, system, messages, tools, think);
    case "openai":
    case "azure":
    case "xai":
      return responsesCall(b, system, messages, tools, think);
    default:
      return chatCall(b, system, messages, tools, think);
  }
}

// A stream whichever API it answers in, gathered into the reply the same API gives unstreamed.
function gathered(events: string): unknown {
  let responses: { output?: unknown; usage?: unknown } | undefined;
  let said = "";
  const items: unknown[] = [];
  const toolCalls = new Map<
    number,
    { id?: string; function: { name?: string; arguments: string } }
  >();
  let usage: unknown;
  let chatRole = false;
  for (const line of events.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: {
      type?: string;
      delta?: unknown;
      item?: unknown;
      response?: { output?: unknown; usage?: unknown; error?: unknown };
      error?: unknown;
      choices?: { delta?: { content?: unknown; tool_calls?: unknown[] } }[];
      usage?: unknown;
    };
    try {
      event = JSON.parse(line.slice(5)) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string")
      said += event.delta;
    else if (event.type === "response.output_item.done") items.push(event.item);
    else if (event.type === "response.completed" || event.type === "response.done")
      responses = event.response;
    else if (event.type === "response.failed" || event.type === "error") {
      const failed = event.response?.error ?? event.error;
      const message = (failed as { message?: unknown } | undefined)?.message;
      throw new ModelAnswerError(
        undefined,
        typeof message === "string" ? message : "the model failed while answering",
      );
    } else if (event.choices) {
      chatRole = true;
      const delta = event.choices[0]?.delta;
      if (typeof delta?.content === "string") said += delta.content;
      for (const raw of delta?.tool_calls ?? []) {
        const call = raw as {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        const at = call.index ?? 0;
        const whole = toolCalls.get(at) ?? { function: { arguments: "" } };
        if (call.id) whole.id = call.id;
        if (call.function?.name) whole.function.name = call.function.name;
        whole.function.arguments += call.function?.arguments ?? "";
        toolCalls.set(at, whole);
      }
      if (event.usage) usage = event.usage;
    }
  }
  if (chatRole)
    return {
      choices: [
        {
          message: {
            content: said,
            ...(toolCalls.size
              ? {
                  tool_calls: [...toolCalls.values()].map((call) => ({
                    type: "function",
                    ...call,
                  })),
                }
              : {}),
          },
        },
      ],
      usage,
    };
  if (Array.isArray(responses?.output) && responses.output.length) return responses;
  return {
    output: items.length
      ? items
      : [{ type: "message", content: [{ type: "output_text", text: said }] }],
    usage: responses?.usage,
  };
}

export async function sideStep(
  b: ModelBinding,
  at: { port: number; token: string },
  system: string,
  messages: readonly SideMessage[],
  tools: readonly SideToolSpec[],
  signal: AbortSignal,
  effort?: ReasoningEffort,
  fetch?: typeof undiciFetch,
): Promise<SideStep> {
  const call = sideCall(b, system, messages, tools, effort);
  const reply = await gatewayPost(b, at, call.path, call.headers, call.body, signal, fetch);
  let parsed: unknown;
  try {
    parsed = reply.streamed ? gathered(reply.body) : JSON.parse(reply.body);
  } catch (error) {
    if (error instanceof ModelAnswerError) throw error;
    throw new ModelAnswerError(undefined, "its answer could not be read");
  }
  return call.read(parsed);
}
