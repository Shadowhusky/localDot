import type { ModelBinding } from "@localdot/protocol";
import { gatewayBaseURL } from "@localdot/providers";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const OUTPUT_TOKENS = 512;
const MAX_REPLY_BYTES = 256 * 1024;

interface Call {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  read(reply: unknown): string;
}

const texts = (parts: unknown, key = "text"): string =>
  Array.isArray(parts)
    ? parts
        .map((part) => (part as Record<string, unknown>)?.[key])
        .filter((text): text is string => typeof text === "string")
        .join("")
    : "";

// One short answer from the fast model, in its provider's own API, as the brain asks it.
export function completionCall(
  b: ModelBinding,
  system: string,
  prompt: string,
  image?: string,
): Call {
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
          generationConfig: { maxOutputTokens: OUTPUT_TOKENS },
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
      return {
        path: "responses",
        headers: b.client === "azure" ? { "api-key": key } : bearer,
        body: {
          model: b.model,
          instructions: system,
          input: image
            ? [
                {
                  role: "user",
                  content: [
                    { type: "input_text", text: prompt },
                    { type: "input_image", image_url: `data:image/png;base64,${image}` },
                  ],
                },
              ]
            : prompt,
          max_output_tokens: OUTPUT_TOKENS,
          store: false,
        },
        read: (reply) =>
          ((reply as { output?: { content?: unknown }[] }).output ?? [])
            .map((item) => texts(item.content))
            .join(""),
      };
    default:
      return {
        path: "chat/completions",
        headers: bearer,
        body: {
          model: b.model,
          max_tokens: OUTPUT_TOKENS,
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
    const call = completionCall(b, system, prompt, image);
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
        await reply.body?.cancel().catch(() => {});
        throw new Error(`the fast model answered ${reply.status}`);
      }
      return call.read(JSON.parse(await cappedText(reply, MAX_REPLY_BYTES)));
    } finally {
      await agent.close().catch(() => {});
    }
  };
}
