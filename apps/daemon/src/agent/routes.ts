import {
  CODEX_VERSION,
  type CodexInstaller,
  type HarnessAvailability,
} from "@localdot/codex-harness";
import { type KeydRecord, keyLikePresent, ULID_PATTERN } from "@localdot/protocol";
import { capabilityOf, PROVIDERS } from "@localdot/providers";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { DesktopdError } from "../desktopd/client.ts";
import type { DesktopdTools } from "../desktopd/tools-client.ts";
import { type KeydClient, KeydUnavailableError } from "../keyd/client.ts";
import {
  BindingError,
  CHATGPT,
  checkChatgptChoice,
  pricingOf,
  type ResolvedRole,
  resolveRole,
} from "./bindings.ts";
import type { CatalogStore } from "./catalog-store.ts";
import { AccountError, type CodexAccount } from "./codex/account.ts";
import { chatgptRoutes } from "./codex/routes.ts";
import { DOWNLOAD_NAME, DownloadError, downloadFile, TRANSFER_BYTES } from "./download.ts";
import { MemoryError, type MemoryStore } from "./memory.ts";
import { AgentError, type AgentRunner } from "./runner.ts";
import { ControlHeldError, SessionStoppedError } from "./session.ts";
import { AgentSettings, SettingsError, type SettingsStore } from "./settings.ts";
import type { SkillInfo } from "./skills.ts";

export interface UploadAccess {
  tools: Pick<DesktopdTools, "putFile">;
  signal: AbortSignal;
  check(): void;
  release(): void;
}
export interface AgentRoutesDeps {
  runner: Pick<AgentRunner, "start" | "get" | "raiseBudget">;
  settings: Pick<SettingsStore, "get" | "put">;
  catalog: Pick<CatalogStore, "get" | "refresh">;
  keyd: Pick<KeydClient, "secrets"> & Partial<Pick<KeydClient, "budget">>;
  memory: Pick<MemoryStore, "readBoth" | "undo">;
  skills(): SkillInfo[];
  // Root owns admission, control/cell lifetime and drain registration. No task is required.
  desktop(cellId: string, requestSignal: AbortSignal): UploadAccess | undefined;
  redactUserText(text: string, sessionId?: string, cellId?: string): string;
  appendTo(sessionId: string, type: "memory.change", data: Record<string, unknown>): void;
  home: string;
  harness?(): HarnessAvailability;
  chatgpt?: {
    account: CodexAccount;
    installer: CodexInstaller;
    availability(): HarnessAvailability;
  };
}

const JSON_BYTES = 64 * 1024;
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.isWellFormed() && !s.includes("\0"));
const nonempty = (max: number) => text(max).refine((s) => s.trim().length > 0);
const Id = z.string().regex(ULID_PATTERN);
const Task = z.strictObject({ task: nonempty(8000) });
const Message = z.strictObject({ text: nonempty(8000), kind: z.enum(["steer", "followup"]) });
const Answer = z
  .strictObject({
    askId: Id,
    option: z
      .string()
      .regex(/^[A-F]$/)
      .optional(),
    text: nonempty(2000).optional(),
  })
  .refine((answer) => answer.option !== undefined || answer.text !== undefined);
const Handback = z.strictObject({ requestId: Id, note: text(1000).optional() });
const Budget = z.strictObject({
  budgetUSD: z
    .number()
    .positive()
    .max(10_000)
    .refine((usd) => Math.floor(usd * 1e6 + 0.5) >= 1),
});

class RouteError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 499 | 503,
    message: string,
  ) {
    super(message);
  }
}
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw new RouteError(499, "request cancelled");
};
function declaredLimit(request: Request, limit: number): void {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
    throw new RouteError(400, "invalid request length");
  if (length !== null && Number(length) > limit) throw new RouteError(413, "request too large");
}
async function empty(request: Request): Promise<void> {
  check(request.signal);
  declaredLimit(request, 0);
  const reader = request.body?.getReader();
  if (!reader) return;
  try {
    for (;;) {
      const part = await read(reader, request.signal);
      check(request.signal);
      if (part.done) return;
      if (part.value.byteLength) throw new RouteError(400, "an empty request body is required");
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function read(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  check(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      void reader.cancel().catch(() => {});
      signal.removeEventListener("abort", abort);
      reject(new RouteError(499, "request cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
async function json<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  check(request.signal);
  declaredLimit(request, JSON_BYTES);
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new RouteError(415, "application/json is required");
  const reader = request.body?.getReader();
  if (!reader) throw new RouteError(400, "invalid request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await read(reader, request.signal);
      check(request.signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > JSON_BYTES) throw new RouteError(413, "request too large");
      chunks.push(part.value);
    }
    try {
      const value = schema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))),
      );
      check(request.signal);
      return value;
    } catch (error) {
      if (error instanceof RouteError) throw error;
      throw new RouteError(400, "invalid request body");
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function fail(error: unknown): Response {
  if (error instanceof RouteError || error instanceof DownloadError)
    return new Response(error.message, { status: error.status });
  if (error instanceof KeydUnavailableError)
    return new Response("the key layer is offline", { status: 503 });
  if (error instanceof AgentError)
    return new Response(
      error.status === 404 ? "no such live task" : "task or computer is not ready for this request",
      { status: error.status },
    );
  if (error instanceof MemoryError)
    return new Response("memory change is unavailable", { status: error.status });
  if (error instanceof SettingsError)
    return new Response("agent settings are unavailable", { status: error.status });
  if (error instanceof BindingError)
    return new Response("the selected models or keys are unavailable", { status: 400 });
  if (error instanceof SessionStoppedError || error instanceof ControlHeldError)
    return new Response("task control changed", { status: 409 });
  if (error instanceof DesktopdError)
    return new Response("the computer transfer failed", {
      status: error.status === 413 ? 413 : 502,
    });
  if (error instanceof Error && error.name === "AbortError")
    return new Response("request cancelled", { status: 499 });
  return new Response("agent request failed", { status: 500 });
}

// Auth remains the application's existing /api guard; no route introduces another credential.
export function agentRoutes(app: Hono, deps: AgentRoutesDeps): void {
  const route = (handler: (c: Context) => Response | Promise<Response>) => async (c: Context) => {
    try {
      check(c.req.raw.signal);
      return await handler(c);
    } catch (error) {
      return fail(error);
    }
  };
  const harness = () =>
    deps.harness?.() ?? {
      available: false,
      reason: "The ChatGPT plan is not set up in this daemon.",
    };
  if (deps.chatgpt) {
    const { account, installer } = deps.chatgpt;
    const installed = () => {
      if (installer.status().state !== "ready")
        throw new AccountError(409, "Install the ChatGPT harness before signing in.");
      const availability = harness();
      if (!availability.available)
        throw new AccountError(503, availability.reason ?? "The ChatGPT plan is unavailable.");
    };
    chatgptRoutes(app, {
      account: {
        status: async (opts) => {
          const availability = harness(),
            install = installer.status();
          if (!availability.available)
            return {
              ...availability,
              codexVersion: CODEX_VERSION,
              state: "unavailable" as const,
              install,
            };
          if (install.state !== "ready")
            return {
              available: true,
              reason: "Install the ChatGPT harness before signing in.",
              codexVersion: CODEX_VERSION,
              state: "unavailable" as const,
              install,
            };
          return { ...(await account.status(opts)), install: installer.status() };
        },
        login: async (method) => {
          installed();
          return account.login(method);
        },
        cancelLogin: () => account.cancelLogin(),
        logout: async () => {
          installed();
          return account.logout();
        },
        refresh: async () => {
          installed();
          return { ...(await account.refresh()), install: installer.status() };
        },
      },
    });
    let flight: Promise<unknown> | undefined;
    app.post(
      "/api/agent/chatgpt/install",
      route(async (c) => {
        await empty(c.req.raw);
        check(c.req.raw.signal);
        if (!deps.chatgpt?.availability().available)
          throw new RouteError(503, "The ChatGPT harness cannot be installed on this computer.");
        // Installation is explicitly requested and daemon-owned; a disconnected HTTP caller
        // does not cancel the shared flight. Its separate cancel action remains available.
        if (!flight) {
          const work = installer.ensureInstalled(new AbortController().signal);
          flight = work;
          void work
            .catch(() => {})
            .finally(() => {
              if (flight === work) flight = undefined;
            });
        }
        return c.json(installer.status(), 202);
      }),
    );
    app.post(
      "/api/agent/chatgpt/install/cancel",
      route(async (c) => {
        await empty(c.req.raw);
        check(c.req.raw.signal);
        installer.cancel();
        return c.body(null, 204);
      }),
    );
  }
  const session = (id: string) => {
    const value = ULID_PATTERN.test(id) ? deps.runner.get(id) : undefined;
    if (!value) throw new RouteError(404, "no such live task");
    return value;
  };
  const active = (id: string) => {
    const value = session(id);
    if (value.stopped) throw new RouteError(409, "task has stopped");
    return value;
  };
  const redact = (value: string, sessionId?: string, cellId?: string, max = 8000) => {
    // Refuse before redaction, allocation, event/inbox dispatch or model-bound persistence.
    if (keyLikePresent(value))
      throw new RouteError(400, "Recognised API keys belong in Keys, not task text.");
    const clean = deps.redactUserText(value, sessionId, cellId);
    if (!text(max).safeParse(clean).success) throw new RouteError(400, "invalid user text");
    return clean;
  };

  app.get(
    "/api/agent/providers",
    route(async (c) => {
      const catalog = deps.catalog.get();
      let keys: KeydRecord[] = [];
      let defaultTaskBudgetUSD: number | null = null;
      let keyLayer: "online" | "offline" = "online";
      try {
        keys = await deps.keyd.secrets();
        if (deps.keyd.budget) {
          try {
            const budget = await deps.keyd.budget();
            const checked = AgentSettings.shape.taskBudgetUSD.unwrap().safeParse(budget.perTaskUSD);
            if (checked.success) defaultTaskBudgetUSD = checked.data;
          } catch (error) {
            if (!(error instanceof KeydUnavailableError)) throw error;
          }
        }
      } catch (error) {
        if (!(error instanceof KeydUnavailableError)) throw error;
        keyLayer = "offline";
      }
      check(c.req.raw.signal);
      return c.json({
        catalog: catalog ? { fetchedAt: catalog.fetchedAt, skipped: catalog.skipped } : null,
        keyLayer,
        defaultTaskBudgetUSD,
        subscriptions: [{ id: CHATGPT, name: "ChatGPT plan", ...harness() }],
        keys: keys
          .filter((key) => key.kind === "llm")
          .map((key) => ({
            id: key.id,
            provider: key.provider,
            ...(key.baseURL ? { baseURL: key.baseURL } : {}),
          })),
        providers: PROVIDERS.map((provider) => ({
          id: provider.id,
          name: provider.name,
          keyd: provider.keyd,
          local: provider.local === true,
          ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
          ...(provider.availableIn ? { availableIn: provider.availableIn } : {}),
          models: Object.values(
            catalog && Object.hasOwn(catalog.providers, provider.id)
              ? (catalog.providers[provider.id]?.models ?? {})
              : {},
          ).map((model) => ({
            id: model.id,
            name: model.name,
            contextTokens: model.contextTokens,
            inputUSDPerMTok: model.inputUSDPerMTok,
            outputUSDPerMTok: model.outputUSDPerMTok,
            ...capabilityOf(provider, model),
          })),
        })),
      });
    }),
  );
  app.post(
    "/api/agent/catalog/refresh",
    route(async (c) => {
      try {
        const catalog = await deps.catalog.refresh();
        check(c.req.raw.signal);
        return c.json({
          fetchedAt: catalog.fetchedAt,
          providers: Object.keys(catalog.providers).length,
          skipped: catalog.skipped,
        });
      } catch (error) {
        if (error instanceof RouteError) throw error;
        return c.text("the catalog could not be refreshed", 502);
      }
    }),
  );
  app.get(
    "/api/agent/settings",
    route((c) => c.json(deps.settings.get())),
  );
  app.put(
    "/api/agent/settings",
    route(async (c) => {
      const parsed = await json(c.req.raw, AgentSettings);
      for (const role of ["main", "fast", "local"] as const) {
        const choice = parsed[role];
        if (choice?.provider === CHATGPT) checkChatgptChoice(role, choice);
      }
      if (parsed.main?.provider !== CHATGPT) {
        const keys = await deps.keyd.secrets();
        check(c.req.raw.signal);
        const catalog = deps.catalog.get();
        const active: ResolvedRole[] = [];
        for (const role of ["main", "fast", "local"] as const) {
          const choice = parsed[role];
          if (choice) active.push(resolveRole(role, choice, catalog, keys));
        }
        if (active.length) pricingOf(active);
      }
      check(c.req.raw.signal);
      return c.json(deps.settings.put(parsed));
    }),
  );
  app.post(
    "/api/cells/:id/agent",
    route(async (c) => {
      const cellId = c.req.param("id") ?? "";
      if (!ULID_PATTERN.test(cellId)) throw new RouteError(400, "invalid computer id");
      const parsed = await json(c.req.raw, Task);
      check(c.req.raw.signal);
      const result = await deps.runner.start(
        cellId,
        redact(parsed.task, undefined, cellId),
        c.req.raw.signal,
      );
      check(c.req.raw.signal);
      return c.json({ sessionId: result.id }, 202);
    }),
  );
  app.get(
    "/api/agent/sessions/:id",
    route((c) => {
      const s = session(c.req.param("id") ?? "");
      return c.json({
        sessionId: s.id,
        cellId: s.cellId,
        status: s.status,
        toolCalls: s.toolCalls,
        ...(s.brainCellId ? { brainCellId: s.brainCellId } : {}),
        ...(s.pendingAsk ? { pendingAsk: s.pendingAsk } : {}),
        ...(s.pendingTakeover ? { pendingTakeover: s.pendingTakeover } : {}),
      });
    }),
  );
  app.post(
    "/api/agent/sessions/:id/messages",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const parsed = await json(c.req.raw, Message);
      check(c.req.raw.signal);
      if (s.stopped) throw new RouteError(409, "task has stopped");
      s.post(parsed.kind, redact(parsed.text, s.id, s.cellId));
      return c.body(null, 202);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/answer",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const parsed = await json(c.req.raw, Answer);
      check(c.req.raw.signal);
      const ok = s.answer(
        parsed.askId,
        parsed.option,
        parsed.text === undefined ? undefined : redact(parsed.text, s.id, s.cellId, 2000),
      );
      return ok ? c.body(null, 204) : c.text("that question is not waiting", 409);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/takeover/done",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const parsed = await json(c.req.raw, Handback);
      check(c.req.raw.signal);
      const ok = s.endTakeover(
        parsed.requestId,
        parsed.note === undefined ? undefined : redact(parsed.note, s.id, s.cellId, 1000),
      );
      return ok ? c.body(null, 204) : c.text("the screen is not handed over", 409);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/budget",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const parsed = await json(c.req.raw, Budget);
      check(c.req.raw.signal);
      if (s.stopped) throw new RouteError(409, "task has stopped");
      await deps.runner.raiseBudget(s.id, parsed.budgetUSD);
      check(c.req.raw.signal);
      return c.body(null, 204);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/resume",
    route((c) => {
      const s = active(c.req.param("id") ?? "");
      if (s.controlHeld || s.status !== "paused")
        throw new RouteError(409, "task is not available to resume");
      s.post("resume", "");
      return c.body(null, 204);
    }),
  );
  app.get(
    "/api/agent/sessions/:id/files/:name",
    route((c) =>
      downloadFile(
        deps.home,
        c.req.param("id") ?? "",
        c.req.param("name") ?? "",
        c.req.raw.signal,
        c.req.raw.method === "HEAD",
      ),
    ),
  );
  app.post(
    "/api/cells/:id/upload",
    route(async (c) => {
      const request = c.req.raw;
      const cellId = c.req.param("id") ?? "";
      const name = c.req.query("name") ?? "";
      if (
        !ULID_PATTERN.test(cellId) ||
        !DOWNLOAD_NAME.test(name) ||
        name === "." ||
        name === ".." ||
        !name.isWellFormed()
      )
        throw new RouteError(400, "invalid upload destination");
      declaredLimit(request, TRANSFER_BYTES);
      check(request.signal);
      const access = deps.desktop(cellId, request.signal);
      if (!access) throw new RouteError(409, "the computer is not available for upload");
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let oversized = false;
      let size = 0;
      try {
        access.check();
        check(access.signal);
        const source = (
          request.body ??
          new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          })
        ).getReader();
        reader = source;
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(output) {
              try {
                access.check();
                check(access.signal);
                const part = await read(source, access.signal);
                access.check();
                check(access.signal);
                if (part.done) {
                  output.close();
                  return;
                }
                size += part.value.byteLength;
                if (size > TRANSFER_BYTES) {
                  oversized = true;
                  throw new RouteError(413, "file too large");
                }
                output.enqueue(part.value);
              } catch (error) {
                void source.cancel().catch(() => {});
                output.error(error);
              }
            },
            cancel() {
              void source.cancel().catch(() => {});
            },
          },
          { highWaterMark: 0 },
        );
        const path = await access.tools.putFile(
          `Downloads/${name}`,
          body,
          undefined,
          access.signal,
        );
        access.check();
        check(access.signal);
        check(request.signal);
        if (oversized) throw new RouteError(413, "file too large");
        return c.json({ path }, 201);
      } catch (error) {
        if (oversized) throw new RouteError(413, "file too large");
        throw error;
      } finally {
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        access.release();
      }
    }),
  );
  app.get(
    "/api/agent/memory",
    route((c) => c.json(deps.memory.readBoth())),
  );
  app.post(
    "/api/agent/memory/:changeId/undo",
    route((c) => {
      const changeId = c.req.param("changeId") ?? "";
      if (!ULID_PATTERN.test(changeId)) throw new RouteError(400, "invalid memory change id");
      const change = deps.memory.undo(changeId);
      deps.appendTo(change.sessionId, "memory.change", {
        file: change.file,
        patch: change.patch,
        changeId: change.changeId,
        undoes: change.undoes,
      });
      return c.json({ changeId: change.changeId });
    }),
  );
  app.get(
    "/api/agent/skills",
    route((c) =>
      c.json(
        deps.skills().map((s) => ({ name: s.name, description: s.description, source: s.source })),
      ),
    ),
  );
}
