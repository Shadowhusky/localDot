import type { ModelBinding, ReasoningEffort } from "@localdot/protocol";
import { gatewayBaseURL, modelControls } from "@localdot/providers";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const OUTPUT_TOKENS = 1024;
// A stream says each word in an event of its own, around the answer's few thousand characters.
const MAX_REPLY_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const REASON_CHARS = 240;

interface Call {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  read(reply: unknown): string;
}

// What a provider said when it refused or failed a call, in its own words.
export class ModelAnswerError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly reason: string,
  ) {
    super(status === undefined ? reason : `answered ${status}${reason ? `: ${reason}` : ""}`);
    this.name = "ModelAnswerError";
  }
}

const clipped = (text: string) => {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS)}…` : line;
};
function saidInError(body: string): string {
  try {
    const reply = JSON.parse(body) as {
      detail?: unknown;
      message?: unknown;
      error?: unknown;
    };
    const error = reply.error as { message?: unknown } | string | undefined;
    const said =
      (typeof error === "object" ? error?.message : error) ?? reply.detail ?? reply.message;
    return typeof said === "string" ? clipped(said) : "";
  } catch {
    return clipped(body);
  }
}

const responsesText = (reply: unknown) =>
  ((reply as { output?: { content?: unknown }[] }).output ?? [])
    .map((item) => texts(item.content))
    .join("");

// Server-sent events open with a field or a comment, JSON with a brace or bracket. A relay may label
// its stream as anything, so the body decides.
const SSE_START = /^\s*(?:data|event|id|retry)?:/;

// A Responses stream's answer: its deltas, or what its last event holds when it sent none.
function streamedText(events: string): string {
  let said = "";
  for (const line of events.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: { type?: string; delta?: unknown; response?: unknown; error?: unknown };
    try {
      event = JSON.parse(line.slice(5)) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string")
      said += event.delta;
    else if (event.type === "response.completed" || event.type === "response.done")
      said ||= responsesText(event.response);
    else if (event.type === "response.failed" || event.type === "error") {
      const failed = (event.response as { error?: unknown } | undefined)?.error ?? event.error;
      throw new ModelAnswerError(
        undefined,
        saidInError(JSON.stringify({ error: failed ?? event })),
      );
    }
  }
  return said;
}

const texts = (parts: unknown, key = "text"): string =>
  Array.isArray(parts)
    ? parts
        .map((part) => (part as Record<string, unknown>)?.[key])
        .filter((text): text is string => typeof text === "string")
        .join("")
    : "";

// The fields that set a model's thinking to `effort` in a plain request, for the wires that take
// one there; any other model thinks as it does by default.
function thinking(b: ModelBinding, effort: ReasoningEffort | undefined): Record<string, unknown> {
  if (!effort || !b.provider) return {};
  const { wire, efforts } = modelControls(b.provider, b.model, b.controls);
  if (!efforts.includes(effort)) return {};
  const off = effort === "none";
  switch (wire) {
    case "effort":
      return b.client === "openai" || b.client === "azure" || b.client === "xai"
        ? { reasoning: { effort } }
        : { reasoning_effort: effort };
    case "openrouter":
      return { reasoning: { effort } };
    case "anthropic":
      return off ? { thinking: { type: "disabled" } } : { output_config: { effort } };
    case "binary-effort":
      return off ? { reasoning_effort: "none" } : {};
    case "deepseek":
      return { thinking: { type: off ? "disabled" : "enabled" } };
    case "thinking":
      return off ? { thinking: { type: "disabled" } } : {};
    case "enable-thinking":
      return off ? { enable_thinking: false } : {};
    case "together":
      return off ? { reasoning: { enabled: false } } : {};
    case "google-level":
      return { thinkingConfig: { thinkingLevel: effort } };
    case "google-budget":
      return off ? { thinkingConfig: { thinkingBudget: 0 } } : {};
    default:
      return {};
  }
}

// One short answer from the fast model, in its provider's own API, as the brain asks it, thinking
// at `effort` where the request can say so.
export function completionCall(
  b: ModelBinding,
  system: string,
  prompt: string,
  image?: string,
  effort?: ReasoningEffort,
): Call {
  const think = thinking(b, effort);
  const key = b.surrogate ?? "";
  const bearer: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  switch (b.client) {
    case "anthropic":
    case "anthropic-compatible":
      return {
        path: "messages",
        headers: {
          ...(b.client === "anthropic" ? { "x-api-key": key } : bearer),
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: b.model,
          max_tokens: OUTPUT_TOKENS,
          ...think,
          system,
          messages: [
            {
              role: "user",
              content: image
                ? [
                    { type: "text", text: prompt },
                    {
                      type: "image",
                      source: { type: "base64", media_type: "image/png", data: image },
                    },
                  ]
                : prompt,
            },
          ],
        },
        read: (reply) => texts((reply as { content?: unknown }).content),
      };
    case "google":
      return {
        path: `models/${b.model}:generateContent`,
        headers: { "x-goog-api-key": key },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                ...(image ? [{ inlineData: { mimeType: "image/png", data: image } }] : []),
              ],
            },
          ],
          generationConfig: { maxOutputTokens: OUTPUT_TOKENS, ...think },
        },
        read: (reply) =>
          texts(
            (reply as { candidates?: { content?: { parts?: unknown } }[] }).candidates?.[0]?.content
              ?.parts,
          ),
      };
    case "openai":
    case "azure":
    case "xai":
      // As the brain asks it: Codex-backed endpoints refuse a bare string and an unstreamed reply.
      return {
        path: "responses",
        headers: b.client === "azure" ? { "api-key": key } : bearer,
        body: {
          model: b.model,
          instructions: system,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                ...(image
                  ? [{ type: "input_image", image_url: `data:image/png;base64,${image}` }]
                  : []),
              ],
            },
          ],
          max_output_tokens: OUTPUT_TOKENS,
          store: false,
          stream: true,
          ...think,
        },
        read: responsesText,
      };
    default:
      return {
        path: "chat/completions",
        headers: bearer,
        body: {
          model: b.model,
          max_tokens: OUTPUT_TOKENS,
          ...think,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: image
                ? [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
                  ]
                : prompt,
            },
          ],
        },
        read: (reply) => {
          const content = (reply as { choices?: { message?: { content?: unknown } }[] })
            .choices?.[0]?.message?.content;
          return typeof content === "string" ? content : texts(content);
        },
      };
  }
}

interface Reply {
  readonly headers: { get(name: string): string | null };
  readonly body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
}

// A reply's text, refused as soon as it says or turns out to be longer than `max` bytes.
export async function cappedText(reply: Reply, max: number): Promise<string> {
  const declared = Number(reply.headers.get("content-length") ?? 0);
  const reader = reply.body?.getReader();
  try {
    if (declared > max) throw new Error("the answer is too large");
    const parts: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done || !chunk.value) break;
      bytes += chunk.value.byteLength;
      if (bytes > max) throw new Error("the answer is too large");
      parts.push(chunk.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes));
  } finally {
    void reader?.cancel().catch(() => {});
  }
}

// Through the task's own keyd listener, where the model's key is swapped in and its cost counted.
export function gatewayCompletion(
  binding: () => ModelBinding | undefined,
  listener: () => { port: number; token: string } | undefined,
  fetch: typeof undiciFetch = undiciFetch,
  effort?: ReasoningEffort,
) {
  return async (
    system: string,
    prompt: string,
    signal: AbortSignal,
    image?: string,
  ): Promise<string> => {
    const b = binding();
    const at = listener();
    if (!b || !at) throw new Error("the fast model is not running");
    const call = completionCall(b, system, prompt, image, effort);
    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${at.port}`,
      token: `Basic ${Buffer.from(`brain:${at.token}`).toString("base64")}`,
      proxyTunnel: false,
    });
    try {
      const reply = await fetch(`${gatewayBaseURL(b.route)}/${call.path}`, {
        method: "POST",
        headers: { ...call.headers, "content-type": "application/json" },
        body: JSON.stringify(call.body),
        dispatcher: agent,
        redirect: "error",
        signal,
      });
      if (!reply.ok) {
        const body = await cappedText(reply, MAX_ERROR_BYTES).catch(() => "");
        throw new ModelAnswerError(reply.status, saidInError(body));
      }
      const body = await cappedText(reply, MAX_REPLY_BYTES);
      if (reply.headers.get("content-type")?.includes("text/event-stream") || SSE_START.test(body))
        return streamedText(body);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new ModelAnswerError(undefined, "its answer could not be read");
      }
      return call.read(parsed);
    } finally {
      await agent.close().catch(() => {});
    }
  };
}
