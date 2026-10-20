import {
  AgentSettingsDocument,
  ClaudeCodeStatus,
  ModelControls,
  SECRET_ID_PATTERN,
} from "@localdot/protocol";
import { PROVIDERS } from "@localdot/providers";
import { z } from "zod";
import type { ApiClient } from "../lib/api.ts";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const model = z.strictObject({
  controls: ModelControls.optional(),
  controlsCheckedAt: z.iso.datetime().optional(),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/),
  name: z.string().max(200),
  contextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  releaseDate: z.string().max(32).optional(),
  inputUSDPerMTok: z.number().nonnegative(),
  outputUSDPerMTok: z.number().nonnegative(),
  tier: z.enum(["native", "vision-tools", "text-only", "no-tools"]),
  computer: z.enum(["none", "generic", "anthropic-toolset", "anthropic-legacy"]),
  coords: z.enum(["pixels", "per1000"]),
  note: z.string().max(512),
});
export const ProviderIndex = z
  .strictObject({
    catalog: z
      .strictObject({
        fetchedAt: z.iso.datetime({ offset: true }).max(64),
        skipped: z.number().int().nonnegative(),
        stale: z.boolean().optional(),
        refreshing: z.boolean().optional(),
        refreshFailed: z.boolean().optional(),
      })
      .nullable(),
    keyLayer: z.enum(["online", "offline"]),
    subscriptions: z
      .array(
        z.discriminatedUnion("id", [
          z.strictObject({
            id: z.literal("chatgpt"),
            name: z.literal("ChatGPT plan"),
            available: z.boolean(),
            reason: z.string().max(512).optional(),
          }),
          z.strictObject({
            id: z.literal("claude-code"),
            name: z.literal("Claude Code (your plan)"),
            available: z.boolean(),
            reason: z.string().max(512).optional(),
          }),
        ]),
      )
      .max(2),
    keys: z
      .array(
        z.strictObject({
          id: z.string().regex(SECRET_ID_PATTERN),
          provider: identifier,
          baseURL: z.string().max(2048).optional(),
        }),
      )
      .max(4096),
    providers: z
      .array(
        z.strictObject({
          id: identifier,
          name: z.string().max(200),
          keyd: identifier,
          local: z.boolean(),
          baseURL: z.string().max(2048).optional(),
          availableIn: z.literal("m8").optional(),
          plan: z.literal(true).optional(),
          rule: z.string().max(512).optional(),
          notOffered: z.string().max(512).optional(),
          models: z.array(model).max(10_000),
        }),
      )
      .max(64),
  })
  .superRefine((index, ctx) => {
    if (
      index.providers.length !== PROVIDERS.length ||
      new Set(index.providers.map((p) => p.id)).size !== index.providers.length
    )
      ctx.addIssue({ code: "custom", message: "provider registry mismatch" });
    for (const p of index.providers) {
      const expected = PROVIDERS.find((row) => row.id === p.id);
      if (
        !expected ||
        p.name !== expected.name ||
        p.keyd !== expected.keyd ||
        p.local !== (expected.local === true) ||
        p.baseURL !== expected.baseURL ||
        p.availableIn !== expected.availableIn ||
        p.plan !== expected.plan ||
        p.rule !== expected.rule ||
        p.notOffered !== expected.notOffered ||
        (p.notOffered !== undefined && p.models.length > 0) ||
        new Set(p.models.map((m) => m.id)).size !== p.models.length
      )
        ctx.addIssue({ code: "custom", message: "provider metadata mismatch" });
    }
    if (new Set(index.keys.map((k) => k.id)).size !== index.keys.length)
      ctx.addIssue({ code: "custom", message: "duplicate key metadata" });
  });
export type ProviderIndex = z.infer<typeof ProviderIndex>;

export class SettingsFailure extends Error {
  constructor(
    readonly uncertain: boolean,
    readonly status?: number,
  ) {
    super(
      uncertain
        ? "The save reply could not be verified. Settings may already have changed; reload saved settings before another save."
        : "Settings could not be loaded or saved. Check the connection, keys and choices, then try again.",
    );
    this.name = "SettingsFailure";
  }
}

async function request(
  api: ApiClient,
  method: "GET" | "PUT" | "POST",
  path: string,
  bytes: number,
  signal?: AbortSignal,
  body?: unknown,
  checkModels = false,
): Promise<unknown> {
  const abort = new AbortController();
  const deadline = AbortSignal.any([
    abort.signal,
    AbortSignal.timeout(15_000),
    ...(signal ? [signal] : []),
  ]);
  const mutation = method === "PUT";
  try {
    deadline.throwIfAborted();
    const response = await api.fetch(`${api.socketUrl("").replace(/^ws/, "http")}${path}`, {
      method,
      headers: {
        authorization: api.authorization(),
        ...(checkModels ? { "x-localdot-check-models": "1" } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: deadline,
    });
    if (response.status === 401) api.rejectUnauthorized?.();
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new SettingsFailure(
        mutation && ![400, 401, 403, 404, 409, 413, 422].includes(response.status),
        response.status,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SettingsFailure(mutation);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "",
      size = 0;
    const cancelled = () => {
      void reader.cancel().catch(() => {});
    };
    deadline.addEventListener("abort", cancelled, { once: true });
    try {
      for (;;) {
        deadline.throwIfAborted();
        const part = await reader.read();
        deadline.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > bytes) throw new SettingsFailure(mutation);
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    } finally {
      deadline.removeEventListener("abort", cancelled);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof SettingsFailure) throw error;
    throw new SettingsFailure(mutation);
  } finally {
    abort.abort();
  }
}
export async function loadSettings(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<AgentSettingsDocument> {
  const raw = await request(api, "GET", "/api/agent/settings", 64 * 1024, signal);
  const parsed = AgentSettingsDocument.safeParse(raw);
  if (!parsed.success) throw new SettingsFailure(false);
  return parsed.data;
}
export async function loadProviderIndex(
  api: ApiClient,
  signal?: AbortSignal,
  checkNow = false,
): Promise<ProviderIndex> {
  const parsed = ProviderIndex.safeParse(
    await request(api, "GET", "/api/agent/providers", 4 * 1024 * 1024, signal, undefined, checkNow),
  );
  if (!parsed.success) throw new SettingsFailure(false);
  return parsed.data;
}
export async function saveSettings(
  api: ApiClient,
  settings: AgentSettingsDocument,
  signal?: AbortSignal,
): Promise<AgentSettingsDocument> {
  const parsed = AgentSettingsDocument.safeParse(settings);
  if (!parsed.success) throw new SettingsFailure(false);
  const saved = AgentSettingsDocument.safeParse(
    await request(api, "PUT", "/api/agent/settings", 64 * 1024, signal, parsed.data),
  );
  if (!saved.success || JSON.stringify(saved.data) !== JSON.stringify(parsed.data))
    throw new SettingsFailure(true);
  return saved.data;
}
// The user's own Claude Code, as its status command reports it; check runs that command again.
export async function loadClaudeCode(
  api: ApiClient,
  fresh: boolean,
  signal?: AbortSignal,
): Promise<ClaudeCodeStatus> {
  const parsed = ClaudeCodeStatus.safeParse(
    await request(
      api,
      fresh ? "POST" : "GET",
      fresh ? "/api/agent/claude-code/check" : "/api/agent/claude-code",
      16 * 1024,
      signal,
    ),
  );
  if (!parsed.success) throw new SettingsFailure(false);
  return parsed.data;
}
export async function refreshCatalog(api: ApiClient, signal?: AbortSignal): Promise<void> {
  const parsed = z
    .strictObject({
      fetchedAt: z.iso.datetime({ offset: true }).max(64),
      providers: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    })
    .safeParse(await request(api, "POST", "/api/agent/catalog/refresh", 4096, signal));
  if (!parsed.success) throw new SettingsFailure(false);
}
