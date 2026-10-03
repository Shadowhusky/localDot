import { ModelBinding, type SecretBinding, TaskPricing, ulid } from "@localdot/protocol";
import { APICallError, streamText } from "ai";
import sharp from "sharp";
import {
  type ProviderComputerInput,
  toComputerAction,
} from "../../../../../cells/brain/src/computer.ts";
import { languageModel } from "../../../../../cells/brain/src/models.ts";
import { type ProxyFetch, proxyFetch } from "../../../../../cells/brain/src/proxy-fetch.ts";
import { toolSet } from "../../../../../cells/brain/src/tools.ts";
import type { KeydClient } from "../../keyd/client.ts";

export const PROVIDER_CASES = ["anthropic", "openai", "google", "lmstudio"] as const;
export type ProviderCaseName = (typeof PROVIDER_CASES)[number];
export const PROBE_BUDGET_USD = 0.25;
export const PROBE_OUTPUT_TOKENS = 1024;
export const PROBE_DEADLINE_MS = 30_000;
type Env = (name: string) => string | undefined;
const SPECS = {
  anthropic: {
    prefix: "ANTHROPIC",
    model: "claude-sonnet-5-5",
    keyEnv: "ANTHROPIC_API_KEY",
    computer: "anthropic-toolset",
    coords: "pixels",
  },
  openai: {
    prefix: "OPENAI",
    model: "gpt-6-luna",
    keyEnv: "OPENAI_API_KEY",
    computer: "generic",
    coords: "pixels",
  },
  google: {
    prefix: "GEMINI",
    model: "gemini-3.1-flash-lite",
    keyEnv: "GEMINI_API_KEY",
    computer: "generic",
    coords: "per1000",
  },
  lmstudio: {
    prefix: "LMSTUDIO",
    model: "qwen/qwen3.8-27b",
    keyEnv: undefined,
    computer: "generic",
    coords: "per1000",
  },
} as const;
export class ProviderProbeError extends Error {
  constructor(
    readonly kind: "configuration" | "billing" | "request" | "answer" | "cleanup",
    message: string,
  ) {
    super(message);
  }
}
export function selectedProviders(env: Env): ReadonlySet<ProviderCaseName> {
  if (env("LOCALDOT_KEYD_TESTS") !== "1") return new Set();
  const names = (env("LOCALDOT_LLM_TESTS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.some((name) => !PROVIDER_CASES.includes(name as ProviderCaseName)))
    throw new ProviderProbeError(
      "configuration",
      "LOCALDOT_LLM_TESTS contains an unsupported case",
    );
  return new Set(names as ProviderCaseName[]);
}
export interface ProviderCase {
  name: ProviderCaseName;
  keyEnv?: string;
  key?: SecretBinding;
  binding: ModelBinding;
  pricing: TaskPricing;
}
// Called only inside a selected test. No credential is read here, including for unselected cases.
export function providerCase(name: ProviderCaseName, env: Env): ProviderCase {
  const spec = SPECS[name];
  const model = env(`${spec.prefix}_CU_MODEL`) ?? spec.model;
  const rate = (side: "INPUT" | "OUTPUT") => {
    const value = env(`${spec.prefix}_CU_${side}_USD_PER_MTOK`);
    if (value === undefined || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
      throw new ProviderProbeError(
        "configuration",
        `${spec.prefix} requires explicit input and output USD per million tokens`,
      );
    const price = Number(value);
    if (!Number.isFinite(price) || price < 0 || price > 10_000)
      throw new ProviderProbeError(
        "configuration",
        "provider prices must be finite and between 0 and 10000",
      );
    return price;
  };
  const input = name === "lmstudio" ? 0 : rate("INPUT");
  const output = name === "lmstudio" ? 0 : rate("OUTPUT");
  if (name !== "lmstudio" && input === 0 && output === 0)
    throw new ProviderProbeError("configuration", "at least one remote price must be positive");
  const binding = ModelBinding.safeParse({
    route: name,
    client: name,
    model,
    computer: spec.computer,
    coords: spec.coords,
    vision: true,
    reasoning: false,
    contextTokens: 200_000,
    maxOutputTokens: PROBE_OUTPUT_TOKENS,
  });
  const pricing = TaskPricing.safeParse({
    v: 1,
    routes: [
      {
        route: name,
        models: [
          {
            id: model,
            inputUSDPerMTok: input,
            outputUSDPerMTok: output,
            maxOutputTokens: PROBE_OUTPUT_TOKENS,
          },
        ],
      },
    ],
  });
  if (!binding.success || !pricing.success)
    throw new ProviderProbeError("configuration", "invalid provider probe model configuration");
  return {
    name,
    binding: binding.data,
    pricing: pricing.data,
    ...(spec.keyEnv
      ? { keyEnv: spec.keyEnv, key: { id: name, kind: "llm", provider: name } as SecretBinding }
      : {}),
  };
}
export function safeProviderError(error: unknown): ProviderProbeError {
  if (error instanceof ProviderProbeError) return error;
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    // Do not mislabel keyd budget/unpriced/auth failures or an arbitrary 5xx as lack of credit.
    if (
      [400, 402, 403, 429].includes(status ?? 0) &&
      (error.responseBody?.length ?? 0) <= 64 * 1024
    ) {
      try {
        const body = JSON.parse(error.responseBody ?? "") as {
          error?: { code?: unknown; type?: unknown; message?: unknown };
        };
        const detail = body.error;
        const code =
          typeof detail?.code === "string"
            ? detail.code
            : typeof detail?.type === "string"
              ? detail.type
              : "";
        const message = typeof detail?.message === "string" ? detail.message : "";
        if (
          ["insufficient_quota", "insufficient_funds", "credit_balance_too_low"].includes(code) ||
          (["", "invalid_request_error", "PERMISSION_DENIED"].includes(code) &&
            /credit balance is too low|insufficient credits|billing (?:is )?disabled/i.test(
              message,
            ))
        )
          return new ProviderProbeError(
            "billing",
            "provider refused the probe for unavailable credit",
          );
      } catch {
        /* Unstructured provider text is never a skip oracle. */
      }
    }
    return new ProviderProbeError(
      "request",
      `provider probe request failed${Number.isInteger(status) ? ` (HTTP ${status})` : ""}`,
    );
  }
  return new ProviderProbeError("request", "provider probe failed or reached its deadline");
}
const TARGETS = [
  { label: "Alpha", x: 120, y: 140, w: 180, h: 64 },
  { label: "Gamma", x: 900, y: 610, w: 180, h: 64 },
  { label: "Delta", x: 560, y: 380, w: 160, h: 56 },
  { label: "Omega", x: 1040, y: 90, w: 150, h: 52 },
];
export async function probeImage(): Promise<Buffer> {
  const buttons = TARGETS.map(
    (t) =>
      `<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" rx="10" fill="#e9eef5" stroke="#5b6b80"/><text x="${t.x + t.w / 2}" y="${t.y + t.h / 2 + 8}" font-family="sans-serif" font-size="24" text-anchor="middle" fill="#1b2330">${t.label}</text>`,
  ).join("");
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#fff"/>${buttons}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}
export function requireGammaClick(
  calls: readonly { toolName: string; input: unknown }[],
  binding: ModelBinding,
): void {
  const call = calls[0];
  if (calls.length !== 1 || call?.toolName !== "computer")
    throw new ProviderProbeError("answer", "provider must return exactly one computer click");
  const action = toComputerAction(call.input as ProviderComputerInput, binding.coords, undefined);
  if (
    typeof action === "string" ||
    action.action !== "click" ||
    action.button !== "left" ||
    action.count !== 1 ||
    !action.point ||
    action.point.x < 900 ||
    action.point.x >= 1080 ||
    action.point.y < 610 ||
    action.point.y >= 674
  )
    throw new ProviderProbeError("answer", "provider click did not land inside Gamma");
}
export async function probeComputer(
  binding: ModelBinding,
  image: Buffer,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<void> {
  try {
    signal.throwIfAborted();
    const computer = toolSet(binding).computer;
    if (!computer) throw new ProviderProbeError("configuration", "provider has no computer tool");
    const result = streamText({
      model: languageModel(binding, fetch),
      tools: { computer },
      maxRetries: 0,
      maxOutputTokens: PROBE_OUTPUT_TOKENS,
      abortSignal: signal,
      onError: () => {},
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "The attached image is the current screen; do not take another screenshot. Click the button labelled Gamma with the computer tool, once, and do nothing else.",
            },
            {
              type: "file",
              data: { type: "data", data: image.toString("base64") },
              mediaType: "image/png",
            },
          ],
        },
      ],
    });
    const calls: { toolName: string; input: unknown }[] = [];
    for await (const part of result.fullStream) {
      signal.throwIfAborted();
      if (part.type === "error") throw part.error;
      if (part.type === "tool-call") calls.push({ toolName: part.toolName, input: part.input });
    }
    signal.throwIfAborted();
    requireGammaClick(calls, binding);
  } catch (error) {
    if (signal.aborted)
      throw new ProviderProbeError("request", "provider probe failed or reached its deadline");
    throw safeProviderError(error);
  }
}
type ProbeKeyd = Pick<KeydClient, "openCell" | "beginPricedTask" | "endTask" | "closeCell">;
// New task/account every case; no shared route-model publication or spending-account reset.
export async function runProviderCase(
  client: ProbeKeyd,
  config: ProviderCase,
  image: Buffer,
  port: number,
  makeProxy: typeof proxyFetch = proxyFetch,
): Promise<void> {
  const cellId = ulid();
  const taskId = ulid();
  let transport: ProxyFetch | undefined;
  let failure: ProviderProbeError | undefined;
  try {
    const opened = await client.openCell({
      cellId,
      role: "brain",
      port,
      secrets: config.key ? [config.key.id] : [],
    });
    await client.beginPricedTask(cellId, taskId, config.pricing, PROBE_BUDGET_USD);
    const binding = ModelBinding.parse({
      ...config.binding,
      ...(config.key ? { surrogate: opened.surrogates?.[config.key.id] } : {}),
    });
    transport = makeProxy(`http://127.0.0.1:${opened.port}`, opened.proxyToken);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PROBE_DEADLINE_MS);
    try {
      await probeComputer(binding, image, transport, abort.signal);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  } catch (error) {
    failure = safeProviderError(error);
  }
  {
    // Attempt every cleanup even if another cleanup fails. Do not retain a task's key access.
    const cleanup: PromiseSettledResult<unknown>[] = [];
    if (transport)
      cleanup.push(
        ...(await Promise.allSettled([Promise.resolve().then(() => transport?.close())])),
      );
    cleanup.push(
      ...(await Promise.allSettled([Promise.resolve().then(() => client.endTask(cellId))])),
    );
    cleanup.push(
      ...(await Promise.allSettled([Promise.resolve().then(() => client.closeCell(cellId))])),
    );
    if (cleanup.some((r) => r.status === "rejected"))
      throw new ProviderProbeError("cleanup", "provider fixture cleanup failed");
  }
  if (failure) throw failure;
}
