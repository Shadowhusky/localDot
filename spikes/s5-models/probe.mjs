import { readFileSync, writeFileSync } from "node:fs";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, tool } from "ai";
import { z } from "zod";
import { TARGETS, centre } from "./probe-image.mjs";
import { SURROGATE, startGateway } from "./swap-gateway.mjs";

const G = "http://127.0.0.1:4797";
startGateway();
const image = readFileSync("out/probe.png");
const target = TARGETS.find((t) => t.label === (process.env.PROBE_TARGET ?? "Gamma"));
const prompt =
  "The attached image is the current screen; do not take another screenshot. " +
  `Click the button labelled ${target.label} with the computer tool, once, and do nothing else.`;

// Cheapest model per provider that the provider accepts for this path (FINDINGS: model choice).
const ANTHROPIC_MODEL = process.env.ANTHROPIC_CU_MODEL ?? "claude-haiku-4-5-20251001";
const OPENAI_MODEL = process.env.OPENAI_CU_MODEL ?? "gpt-6-luna";
const GEMINI_MODEL = process.env.GEMINI_CU_MODEL ?? "gemini-3.1-flash-lite";
const LMSTUDIO_MODEL = "qwen/qwen3.8-27b";

// Anthropic and the generic tool return { action, coordinate: [x, y] }; OpenAI returns { actions: [{ x, y }] }.
const coordinatesOf = (input) => {
  if (Array.isArray(input?.coordinate)) return input.coordinate;
  const action = input?.actions?.find((a) => Number.isFinite(a?.x));
  return action ? [action.x, action.y] : [Number.NaN, Number.NaN];
};

// The provider's own events, before the SDK buffers them: Anthropic input_json_delta, OpenAI Responses
// items and argument deltas, Gemini functionCall parts, OpenAI-compatible tool_call argument deltas.
const wireFragment = (raw) => {
  if (raw?.type === "content_block_delta" && raw.delta?.type === "input_json_delta") return raw.delta.partial_json;
  if (raw?.type === "response.function_call_arguments.delta") return raw.delta;
  if (raw?.type === "response.output_item.done" && raw.item?.type === "computer_call") return JSON.stringify(raw.item);
  const parts = raw?.candidates?.[0]?.content?.parts ?? [];
  const calls = parts.filter((p) => p.functionCall).map((p) => JSON.stringify(p.functionCall.args ?? {}));
  const deltas = (raw?.choices?.[0]?.delta?.tool_calls ?? []).map((t) => t.function?.arguments ?? "");
  return [...calls, ...deltas].join("");
};
const WIRE_COORDINATE = /"coordinate"\s*:\s*\[\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\]|"x"\s*:\s*-?[\d.]+\s*,\s*"y"\s*:\s*-?[\d.]+\s*[,}]/;

const secrets = [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.GEMINI_API_KEY].filter(Boolean);
const redact = (text) =>
  secrets
    .reduce((acc, secret) => acc.split(secret).join("[key]"), String(text))
    .replace(/\bsk-[A-Za-z0-9_*-]{6,}|\bAIza[0-9A-Za-z_-]{10,}/g, "[key]");

const genericComputer = (space) =>
  tool({
    description: `Operate a 1280x800 screen. Coordinates are ${space === "per1000" ? "0-1000 relative to width and height" : "screenshot pixels"}.`,
    // Not z.tuple: its draft-07 `items: [...]` is rejected by Gemini ("items must be a boolean or an object").
    inputSchema: z.object({ action: z.enum(["left_click"]), coordinate: z.array(z.number()).length(2) }),
  });

const anthropic = createAnthropic({ baseURL: `${G}/anthropic/v1`, apiKey: SURROGATE });
const anthropicLegacyTool = ANTHROPIC_MODEL.startsWith("claude-haiku-4-5");
const openai = createOpenAI({ baseURL: `${G}/openai/v1`, apiKey: SURROGATE });
const google = createGoogleGenerativeAI({ baseURL: `${G}/google/v1beta`, apiKey: SURROGATE });
const lmstudio = createOpenAICompatible({ name: "lmstudio", baseURL: `${G}/lmstudio/v1`, apiKey: SURROGATE, includeUsage: true });

const cases = [
  {
    name: `anthropic ${ANTHROPIC_MODEL} (${anthropicLegacyTool ? "computer_20250124" : "computer toolset"})`,
    model: anthropic(ANTHROPIC_MODEL),
    tools: {
      computer: anthropicLegacyTool
        ? anthropic.tools.computer_20250124({ displayWidthPx: 1280, displayHeightPx: 800 })
        : anthropic.tools.computerToolset_20260801({}),
    },
    space: "pixels",
  },
  {
    name: `openai ${OPENAI_MODEL} (computer tool)`,
    model: openai.responses(OPENAI_MODEL),
    tools: { computer: openai.tools.computer({}) },
    space: "pixels",
  },
  {
    name: `google ${GEMINI_MODEL} (generic tool, pixels)`,
    model: google(GEMINI_MODEL),
    tools: { computer: genericComputer("pixels") },
    space: "pixels",
  },
  {
    name: `google ${GEMINI_MODEL} (generic tool, per1000)`,
    model: google(GEMINI_MODEL),
    tools: { computer: genericComputer("per1000") },
    space: "per1000",
  },
  {
    name: "lmstudio qwen3.8-27b (generic tool, per1000)",
    model: lmstudio(LMSTUDIO_MODEL),
    tools: { computer: genericComputer("per1000") },
    space: "per1000",
  },
  {
    name: "lmstudio qwen3.8-27b (generic tool, pixels)",
    model: lmstudio(LMSTUDIO_MODEL),
    tools: { computer: genericComputer("pixels") },
    space: "pixels",
  },
].filter((c) => !process.env.PROBE_CASES || process.env.PROBE_CASES.split(",").some((s) => c.name.includes(s)));

const want = centre(target);
const toScreen = (space, [x, y]) => (space === "per1000" ? { x: (x / 1000) * 1280, y: (y / 1000) * 800 } : { x, y });
const judge = (space, xy) => {
  const p = toScreen(space, xy);
  return {
    screen: { x: Math.round(p.x), y: Math.round(p.y) },
    offBy: Math.round(Math.hypot(p.x - want.x, p.y - want.y)),
    hit: p.x >= target.x && p.x <= target.x + target.w && p.y >= target.y && p.y <= target.y + target.h,
  };
};

const results = [];
for (const c of cases) {
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const ms = { firstChunk: null, inputStart: null, firstDelta: null, firstFragment: null, wireCoordinate: null, toolCall: null, end: null };
  let call = null;
  let usage = null;
  let wire = "";
  let fragments = 0;
  let text = "";
  let reasoningChars = 0;
  const calls = [];
  try {
    const result = streamText({
      model: c.model,
      tools: c.tools,
      maxRetries: 0,
      includeRawChunks: true,
      onError: () => {},
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "file", data: image, mediaType: "image/png" }] }],
    });
    for await (const part of result.fullStream) {
      if (part.type === "raw") {
        ms.firstChunk ??= now();
        const fragment = wireFragment(part.rawValue);
        if (fragment) {
          fragments += 1;
          ms.firstFragment ??= now();
        }
        wire += fragment;
        if (ms.wireCoordinate === null && WIRE_COORDINATE.test(wire)) ms.wireCoordinate = now();
      }
      if (part.type === "tool-input-start") ms.inputStart ??= now();
      if (part.type === "tool-input-delta") ms.firstDelta ??= now();
      if (part.type === "text-delta") text += part.text;
      if (part.type === "reasoning-delta") reasoningChars += part.text.length;
      if (part.type === "tool-call") {
        calls.push(part.input);
        if (call === null && Number.isFinite(coordinatesOf(part.input)[0])) {
          call = part.input;
          ms.toolCall = now();
        }
      }
      if (part.type === "finish") usage = part.totalUsage;
      if (part.type === "error") throw part.error;
    }
    ms.end = now();
    const xy = coordinatesOf(call ?? calls[0]);
    const other = c.space === "per1000" ? "pixels" : "per1000";
    results.push({
      case: c.name,
      raw: call ?? calls[0] ?? null,
      space: c.space,
      ...judge(c.space, xy),
      ifOtherSpace: { space: other, ...judge(other, xy) },
      firstChunkMs: ms.firstChunk,
      inputStartMs: ms.inputStart,
      firstDeltaMs: ms.firstDelta,
      wireFragments: fragments,
      firstWireFragmentMs: ms.firstFragment,
      wireCoordinateMs: ms.wireCoordinate,
      totalMs: ms.toolCall,
      endMs: ms.end,
      toolCalls: calls.length,
      usage: usage && { input: usage.inputTokens, output: usage.outputTokens, reasoning: usage.outputTokenDetails?.reasoningTokens },
      reasoningChars,
      text: redact(text).slice(0, 200),
    });
  } catch (err) {
    results.push({
      case: c.name,
      status: err?.statusCode ?? err?.lastError?.statusCode,
      error: redact(err?.message ?? err).slice(0, 300),
      elapsedMs: now(),
    });
  }
  console.log(results.at(-1));
}
writeFileSync(process.env.PROBE_OUT ?? "out/results.json", JSON.stringify(results, null, 2));
process.exit(0);
