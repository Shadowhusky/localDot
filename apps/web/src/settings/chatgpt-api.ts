import {
  CHATGPT_DEVICE_CODE_OFF,
  ChatgptSandbox,
  CodexInstallState,
  ReasoningEffort,
  SubscriptionUsageData,
} from "@localdot/protocol";
import { z } from "zod";
import type { ApiClient } from "../lib/api.ts";
import type { SubscriptionModel } from "./choices.ts";

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s));
const login = z.strictObject({
  loginId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  method: z.literal("code"),
  verificationUrl: z.literal("https://auth.openai.com/codex/device"),
  userCode: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const TIER = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const models = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      name: text(128).min(1),
      isDefault: z.boolean(),
      efforts: z.array(ReasoningEffort).max(8).optional(),
      // The account's own tier for each premium speed it offers the model.
      tiers: z
        .strictObject({
          fast: z.string().regex(TIER).optional(),
          ultrafast: z.string().regex(TIER).optional(),
        })
        .optional(),
    }),
  )
  .max(128)
  .refine((rows) => new Set(rows.map((m) => m.id)).size === rows.length);
const status = z
  .strictObject({
    available: z.boolean(),
    codexVersion: z.literal("0.154.0"),
    state: z.enum(["unavailable", "signed_out", "signing_in", "signed_in", "expired"]),
    install: CodexInstallState,
    sandbox: ChatgptSandbox,
    reason: text(512).optional(),
    lastError: text(512).optional(),
    account: z
      .strictObject({
        email: text(254).nullable(),
        plan: z.enum([
          "free",
          "go",
          "plus",
          "pro",
          "team",
          "business",
          "enterprise",
          "edu",
          "unknown",
        ]),
      })
      .optional(),
    login: login.optional(),
    usage: SubscriptionUsageData.optional(),
    models: models.optional(),
    checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.state === "signed_in" && (!value.available || !value.account)) ||
      (value.state !== "unavailable" &&
        (value.install.state !== "ready" || value.sandbox !== "passed")) ||
      (value.login && value.state !== "signing_in") ||
      (!value.available && value.state !== "unavailable")
    )
      ctx.addIssue({ code: "custom", message: "account state mismatch" });
  });
export type ChatgptResponse = z.infer<typeof status>;
export type ChatgptLoginMaterial = z.infer<typeof login>;
export type ChatgptSummary = Omit<ChatgptResponse, "lastError" | "login" | "models"> & {
  login?: Pick<ChatgptLoginMaterial, "loginId" | "startedAt">;
  models?: (SubscriptionModel & { isDefault: boolean })[];
};
// Copy public fields explicitly. Device codes and URLs never enter React state, logs or storage.
export function chatgptSummary(value: ChatgptResponse): ChatgptSummary {
  return {
    available: value.available,
    codexVersion: value.codexVersion,
    state: value.state,
    install: value.install,
    sandbox: value.sandbox,
    ...(value.reason ? { reason: value.reason } : {}),
    ...(value.account ? { account: value.account } : {}),
    ...(value.usage ? { usage: value.usage } : {}),
    ...(value.models
      ? {
          models: value.models.map(({ tiers, ...model }) => ({
            ...model,
            ...(tiers
              ? { speeds: (["fast", "ultrafast"] as const).filter((speed) => tiers[speed]) }
              : {}),
          })),
        }
      : {}),
    ...(value.checkedAt === undefined ? {} : { checkedAt: value.checkedAt }),
    ...(value.login
      ? { login: { loginId: value.login.loginId, startedAt: value.login.startedAt } }
      : {}),
  };
}
export class ChatgptFailure extends Error {
  constructor(
    readonly uncertain: boolean,
    readonly status?: number,
    readonly refusal?: string,
  ) {
    super(
      refusal ??
        (status === 503
          ? "ChatGPT account changes could not be safely completed. New ChatGPT tasks are blocked; check account status before continuing."
          : uncertain
            ? "The reply could not be verified. Check account status before another action."
            : "ChatGPT status or the requested action is unavailable. Check the connection and try again."),
    );
    this.name = "ChatgptFailure";
  }
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(new Error("account request ended")));
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) abort();
  });
}
async function readText(
  response: Response,
  limit: number,
  deadline: AbortSignal,
  mutation: boolean,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let raw = "",
    size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  deadline.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      deadline.throwIfAborted();
      const chunk = await bounded(reader.read(), deadline);
      deadline.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new ChatgptFailure(mutation);
      raw += decoder.decode(chunk.value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    deadline.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function request(
  api: ApiClient,
  method: "GET" | "POST",
  path: string,
  expected: number,
  signal: AbortSignal,
  body?: unknown,
  refusal?: string,
): Promise<unknown> {
  const cancel = new AbortController();
  const deadline = AbortSignal.any([
    signal,
    cancel.signal,
    AbortSignal.timeout(method === "GET" ? 15_000 : 30_000),
  ]);
  const mutation = method === "POST";
  try {
    deadline.throwIfAborted();
    const fetching = api.fetch(`${api.socketUrl("").replace(/^ws/, "http")}${path}`, {
      method,
      headers: {
        authorization: api.authorization(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: deadline,
    });
    void fetching.then(
      (late) => {
        if (deadline.aborted) void late.body?.cancel().catch(() => {});
      },
      () => {},
    );
    const response = await bounded(fetching, deadline);
    if (response.status === 401) api.rejectUnauthorized?.();
    if (response.status !== expected) {
      // Only this exact sentence is shown; any other refusal body stays hidden.
      if (
        refusal &&
        response.status === 503 &&
        (await readText(response, 1024, deadline, mutation).catch(() => "")) === refusal
      )
        throw new ChatgptFailure(false, 503, refusal);
      void response.body?.cancel().catch(() => {});
      throw new ChatgptFailure(
        mutation && ![400, 401, 403, 404, 409, 413, 415, 422, 429].includes(response.status),
        response.status,
      );
    }
    if (!response.body) {
      if (expected === 204) return undefined;
      throw new ChatgptFailure(mutation);
    }
    const raw = await readText(response, expected === 204 ? 0 : 64 * 1024, deadline, mutation);
    return expected === 204 ? undefined : JSON.parse(raw);
  } catch (failure) {
    if (failure instanceof ChatgptFailure) throw failure;
    throw new ChatgptFailure(mutation);
  } finally {
    cancel.abort();
  }
}
function checked<T>(schema: z.ZodType<T>, raw: unknown, mutation: boolean): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ChatgptFailure(mutation);
  return parsed.data;
}
export async function readChatgpt(api: ApiClient, signal: AbortSignal): Promise<ChatgptResponse> {
  return checked(status, await request(api, "GET", "/api/agent/chatgpt", 200, signal), false);
}
export async function installChatgpt(
  api: ApiClient,
  signal: AbortSignal,
): Promise<CodexInstallState> {
  return checked(
    CodexInstallState,
    await request(api, "POST", "/api/agent/chatgpt/install", 202, signal),
    true,
  );
}
export async function checkChatgpt(api: ApiClient, signal: AbortSignal): Promise<ChatgptSandbox> {
  return checked(
    z.strictObject({ sandbox: ChatgptSandbox }),
    await request(api, "POST", "/api/agent/chatgpt/check", 202, signal),
    true,
  ).sandbox;
}
export async function loginChatgpt(
  api: ApiClient,
  signal: AbortSignal,
): Promise<ChatgptLoginMaterial> {
  return checked(
    login,
    await request(
      api,
      "POST",
      "/api/agent/chatgpt/login",
      202,
      signal,
      { method: "code" },
      CHATGPT_DEVICE_CODE_OFF,
    ),
    true,
  );
}
export async function cancelChatgpt(
  api: ApiClient,
  kind: "install" | "login",
  signal: AbortSignal,
): Promise<void> {
  await request(api, "POST", `/api/agent/chatgpt/${kind}/cancel`, 204, signal);
}
export async function logoutChatgpt(api: ApiClient, signal: AbortSignal): Promise<void> {
  await request(api, "POST", "/api/agent/chatgpt/logout", 204, signal);
}
export async function refreshChatgpt(
  api: ApiClient,
  signal: AbortSignal,
): Promise<ChatgptResponse> {
  return checked(
    status,
    await request(api, "POST", "/api/agent/chatgpt/refresh", 200, signal),
    true,
  );
}
