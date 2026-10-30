import { homedir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_INSTALL_FIRST,
  CHATGPT_SWITCHED_OFF,
  CODEX_VERSION,
  type CodexInstaller,
  type HarnessAvailability,
} from "@localdot/codex-harness";
import {
  ActionClass,
  AddMemoryEntryRequest,
  AddPersonRequest,
  ApprovalAnswer,
  BudgetRaiseRequest,
  CLAUDE_PLAN_REFUSAL,
  ContinueConversation,
  EditMemoryEntryRequest,
  EditPersonRequest,
  HandbackRequest,
  type KeydRecord,
  MEMORY_ENTRY_ID,
  MemoryEntriesReply,
  MemoryEntryChangeReply,
  MemoryEntryRevision,
  MemoryFileName,
  NOTES_FILE,
  PauseRequest,
  PeopleReply,
  Person,
  PersonaId,
  PersonChangeReply,
  PersonRevision,
  QuestionAnswerRequest,
  RecentActivityReply,
  type RecentTask,
  ResearchChange,
  ResumeSafetyRequest,
  sameCredential,
  scanKeyLike,
  type TakeComputerReply,
  type TakeControlReply,
  TakeoverInputRequest,
  ULID_PATTERN,
} from "@localdot/protocol";
import { capabilityOf, PROVIDERS } from "@localdot/providers";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  type DesktopSignIn,
  desktopSignIn,
  SignInRequest,
  signInSite,
  signInUrl,
} from "../../../../packages/protocol/src/accounts.ts";
import {
  UserBrowserSignInReply,
  UserBrowserSignInRequest,
} from "../../../../packages/protocol/src/browser-sign-in.ts";
import type { BrowserScope } from "../browser/client.ts";
import { type QuarantineRoutesDeps, quarantineRoutes } from "../browser/quarantine-routes.ts";
import { DesktopdError } from "../desktopd/client.ts";
import type { DesktopdTools } from "../desktopd/tools-client.ts";
import { type KeydClient, KeydUnavailableError } from "../keyd/client.ts";
import {
  activeRoles,
  BindingError,
  CHATGPT,
  CLAUDE_CODE,
  checkPlanChoices,
  pricingOf,
  type ResolvedRole,
  resolveRole,
} from "./bindings.ts";
import type { CatalogStore } from "./catalog-store.ts";
import type { ClaudeCodeSetup } from "./claude-code/setup.ts";
import { AccountError, type CodexAccount } from "./codex/account.ts";
import { chatgptRoutes } from "./codex/routes.ts";
import { type ChatgptSetupControl, SANDBOX_REASONS } from "./codex/setup.ts";
import type { Conversations } from "./conversation.ts";
import { DOWNLOAD_NAME, DownloadError, downloadFile, TRANSFER_BYTES } from "./download.ts";
import { type ManualDesktop, ManualInputUncertain, sendManualInput } from "./manual-input.ts";
import { MemoryError, type MemoryStore, type StoredEntry } from "./memory.ts";
import { PeopleError, type PeopleStore, type StoredPerson } from "./people.ts";
import type { PlanUsageStore } from "./plan-usage.ts";
import { AgentError, type AgentRunner, CLAUDE_CODE_OFF, RAISE_BUDGET_FIRST } from "./runner.ts";
import type { PurposeService } from "./safety/purpose-service.ts";
import { RuleError, RulesStore, ruleChange } from "./safety/rules.ts";
import { PausedStepError } from "./safety/step-barrier.ts";
import { type AgentSession, ControlHeldError, SessionStoppedError } from "./session.ts";
import { AgentSettings, SettingsError, type SettingsStore } from "./settings.ts";
import { SIDE_QUESTION_CHARS, SideQuestionError } from "./side-question.ts";
import type { SkillInfo } from "./skills.ts";
import { type DayLimitKeyd, syncDayLimit } from "./spending.ts";
import { userUploadRoutes } from "./user-upload-routes.ts";
import type { UserUploads } from "./user-uploads.ts";

export interface UploadAccess {
  tools: Pick<DesktopdTools, "putFile">;
  signal: AbortSignal;
  check(): void;
  release(): void;
}
export interface AgentRoutesDeps {
  remoteLinks?: import("../remote/links.ts").RemoteLinks;
  uploads?: { store: UserUploads; hasCell(id: string): boolean };
  runner: Pick<AgentRunner, "start" | "get" | "raiseBudget"> &
    Partial<
      Pick<
        AgentRunner,
        | "selectionOf"
        | "terminalOf"
        | "pauseTask"
        | "stopRun"
        | "resumeSafety"
        | "budgetHoldOf"
        | "sessions"
        | "release"
        | "hold"
        | "holds"
        | "signIn"
        | "sideAnswer"
        | "switchPersona"
        | "liveStatus"
      >
    >;
  conversations?: Pick<
    Conversations,
    | "current"
    | "snapshot"
    | "begin"
    | "select"
    | "has"
    | "list"
    | "withdrawStopped"
    | "leave"
    | "discard"
  >;
  settings: Pick<SettingsStore, "get" | "put">;
  purpose?: Pick<PurposeService, "status" | "test">;
  catalog: Pick<CatalogStore, "get" | "refresh" | "fresh" | "freshness">;
  keyd: Pick<KeydClient, "secrets"> & DayLimitKeyd;
  memory: Pick<
    MemoryStore,
    "readBoth" | "undo" | "entries" | "notes" | "addEntry" | "editEntry" | "deleteEntry"
  >;
  // A daily-notes file the user changed, for search to read again.
  notesChanged?(file: string): void;
  people?: Pick<PeopleStore, "list" | "add" | "edit" | "remove">;
  // The tasks the next one hears about, whether or not the user has switched that off.
  recentActivity?(): RecentTask[];
  sessionInfo?(ids: readonly string[]): Map<string, { title: string | null; startedAt: string }>;
  skills(): SkillInfo[];
  canChangeMemory?(): boolean;
  taskMutationReady?(session: AgentSession): boolean;
  // Root owns admission, control/cell lifetime and drain registration. No task is required.
  desktop(cellId: string, requestSignal: AbortSignal): UploadAccess | undefined;
  manual?(session: AgentSession, scope: BrowserScope): ManualDesktop | undefined;
  // The address of the page the desktop's own browser shows, if it is open.
  desktopPage?(cellId: string, signal: AbortSignal): Promise<string | undefined>;
  redactUserText(text: string, sessionId?: string, cellId?: string): string;
  appendTo(sessionId: string, type: "memory.change", data: Record<string, unknown>): void;
  home: string;
  quarantine?: QuarantineRoutesDeps;
  harness?(): HarnessAvailability;
  chatgpt?: {
    account: CodexAccount;
    installer: CodexInstaller;
    availability(): HarnessAvailability;
    setup: ChatgptSetupControl;
  };
  claudeCode?: Pick<ClaudeCodeSetup, "status" | "check">;
  planUsage?: Pick<PlanUsageStore, "reply" | "refresh">;
}

const JSON_BYTES = 64 * 1024;
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.isWellFormed() && !s.includes("\0"));
const nonempty = (max: number) => text(max).refine((s) => s.trim().length > 0);
// research: dot reads many sources and writes a cited report.
const Task = z.strictObject({
  task: nonempty(8000),
  mode: z.literal("research").optional(),
  // The conversation's latest task, or null for a new conversation; left out, the current one.
  continues: z.string().regex(ULID_PATTERN).nullable().optional(),
});
const Message = z.strictObject({ text: nonempty(8000), kind: z.enum(["steer", "followup"]) });
const Budget = BudgetRaiseRequest;
const SideQuestion = z.strictObject({ question: nonempty(SIDE_QUESTION_CHARS) });

class RouteError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 499 | 502 | 503,
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
  if (error instanceof ManualInputUncertain)
    return new Response("manual input completion could not be confirmed; use Stop", {
      status: 499,
    });
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
  if (error instanceof PeopleError) return new Response(error.message, { status: error.status });
  if (error instanceof SettingsError)
    return new Response("agent settings are unavailable", { status: error.status });
  if (error instanceof RuleError) return new Response(error.message, { status: error.status });
  if (error instanceof BindingError)
    return new Response("the selected models or keys are unavailable", { status: 400 });
  if (error instanceof SessionStoppedError || error instanceof ControlHeldError)
    return new Response("task control changed", { status: 409 });
  if (error instanceof PausedStepError)
    return new Response("Pause is changing; try again in a moment", { status: 409 });
  if (error instanceof DesktopdError)
    return new Response("the computer transfer failed", {
      status: error.status === 413 || error.status === 409 ? error.status : 502,
    });
  if (error instanceof Error && error.name === "AbortError")
    return new Response("request cancelled", { status: 499 });
  return new Response("agent request failed", { status: 500 });
}

// Auth remains the application's existing /api guard; no route introduces another credential.
export function agentRoutes(app: Hono, deps: AgentRoutesDeps): void {
  if (deps.uploads) userUploadRoutes(app, deps.uploads.store, deps.uploads.hasCell);
  if (deps.quarantine) quarantineRoutes(app, deps.quarantine);
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
      reason: CHATGPT_SWITCHED_OFF,
    };
  if (deps.chatgpt) {
    const { account, installer, setup } = deps.chatgpt;
    const installed = () => {
      if (installer.status().state !== "ready") throw new AccountError(409, CHATGPT_INSTALL_FIRST);
      const availability = harness();
      if (!availability.available)
        throw new AccountError(503, availability.reason ?? "The ChatGPT plan is unavailable.");
      const sandbox = setup.sandbox();
      if (sandbox !== "passed") throw new AccountError(409, SANDBOX_REASONS[sandbox]);
    };
    const progress = () => ({ install: installer.status(), sandbox: setup.sandbox() });
    chatgptRoutes(app, {
      account: {
        status: async (opts) => {
          const availability = harness();
          if (!availability.available)
            return {
              ...availability,
              codexVersion: CODEX_VERSION,
              state: "unavailable" as const,
              ...progress(),
            };
          if (installer.status().state !== "ready")
            return {
              available: true,
              reason: CHATGPT_INSTALL_FIRST,
              codexVersion: CODEX_VERSION,
              state: "unavailable" as const,
              ...progress(),
            };
          // An installation that predates this check, or a check a restart interrupted.
          if (setup.sandbox() === "unchecked") void setup.check();
          const sandbox = setup.sandbox();
          if (sandbox !== "passed")
            return {
              available: true,
              reason: SANDBOX_REASONS[sandbox],
              codexVersion: CODEX_VERSION,
              state: "unavailable" as const,
              ...progress(),
            };
          return { ...(await setup.confirm(await account.status(opts))), ...progress() };
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
          return { ...(await setup.confirm(await account.refresh())), ...progress() };
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
          throw new RouteError(503, "ChatGPT support can't be installed on this computer.");
        // Installation is explicitly requested and daemon-owned; a disconnected HTTP caller
        // does not cancel the shared flight. Its separate cancel action remains available.
        // The sandbox check follows on its own, before any sign-in can start.
        if (!flight) {
          const work = installer.ensureInstalled(new AbortController().signal);
          flight = work;
          void work
            .then(() => setup.check())
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
    app.post(
      "/api/agent/chatgpt/check",
      route(async (c) => {
        await empty(c.req.raw);
        check(c.req.raw.signal);
        const availability = harness();
        if (!availability.available)
          throw new RouteError(503, availability.reason ?? "The ChatGPT plan is unavailable.");
        if (installer.status().state !== "ready") throw new RouteError(409, CHATGPT_INSTALL_FIRST);
        void setup.check();
        return c.json({ sandbox: setup.sandbox() }, 202);
      }),
    );
  }
  const claudeCode = deps.claudeCode;
  if (claudeCode) {
    app.get(
      "/api/agent/claude-code",
      route(async (c) => c.json(await claudeCode.status())),
    );
    app.post(
      "/api/agent/claude-code/check",
      route(async (c) => {
        await empty(c.req.raw);
        check(c.req.raw.signal);
        return c.json(await claudeCode.check());
      }),
    );
  }
  const planUsage = deps.planUsage;
  if (planUsage)
    // `fresh=1` also reads plans whose figures are not fresh from their own apps, in the background.
    app.get(
      "/api/agent/plan-usage",
      route(async (c) => {
        if (c.req.query("fresh") === "1") void planUsage.refresh();
        return c.json(planUsage.reply());
      }),
    );
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
    const scan = scanKeyLike(value);
    if (scan.overflow || scan.matches.length > 0)
      throw new RouteError(
        400,
        scan.matches.some((match) => match.hint === "Claude plan token")
          ? CLAUDE_PLAN_REFUSAL
          : "Recognised API keys belong in Keys, not task text.",
      );
    const clean = deps.redactUserText(value, sessionId, cellId);
    if (!text(max).safeParse(clean).success) throw new RouteError(400, "invalid user text");
    return clean;
  };

  app.get(
    "/api/agent/providers",
    route(async (c) => {
      const catalog = await deps.catalog.fresh(c.req.header("x-localdot-check-models") === "1");
      let keys: KeydRecord[] = [];
      let keyLayer: "online" | "offline" = "online";
      try {
        keys = await deps.keyd.secrets();
      } catch (error) {
        if (!(error instanceof KeydUnavailableError)) throw error;
        keyLayer = "offline";
      }
      check(c.req.raw.signal);
      return c.json({
        catalog: catalog
          ? { fetchedAt: catalog.fetchedAt, skipped: catalog.skipped, ...deps.catalog.freshness() }
          : null,
        keyLayer,
        subscriptions: [
          { id: CHATGPT, name: "ChatGPT plan", ...harness() },
          {
            id: CLAUDE_CODE,
            name: "Claude Code (your plan)",
            available: !!claudeCode,
            ...(claudeCode ? {} : { reason: CLAUDE_CODE_OFF }),
          },
        ],
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
          ...(provider.plan ? { plan: true } : {}),
          ...(provider.rule ? { rule: provider.rule } : {}),
          ...(provider.notOffered ? { notOffered: provider.notOffered } : {}),
          models: Object.values(
            catalog && !provider.notOffered && Object.hasOwn(catalog.providers, provider.id)
              ? (catalog.providers[provider.id]?.models ?? {})
              : {},
          ).map((model) => ({
            id: model.id,
            name: model.name,
            contextTokens: model.contextTokens,
            ...(model.releaseDate ? { releaseDate: model.releaseDate } : {}),
            inputUSDPerMTok: model.inputUSDPerMTok,
            outputUSDPerMTok: model.outputUSDPerMTok,
            ...capabilityOf(provider, model),
            maxOutputTokens: model.maxOutputTokens,
            ...(model.controls
              ? { controls: model.controls, controlsCheckedAt: model.controlsCheckedAt }
              : {}),
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
    "/api/agent/purpose-check",
    route(async (c) => {
      if (!deps.purpose) throw new RouteError(503, "Purpose check diagnostics are unavailable.");
      return c.json(await deps.purpose.status());
    }),
  );
  app.post(
    "/api/agent/purpose-check/test",
    route(async (c) => {
      if (!deps.purpose) throw new RouteError(503, "Purpose check diagnostics are unavailable.");
      return c.json(await deps.purpose.test());
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
      checkPlanChoices(parsed);
      if (parsed.main?.provider !== CHATGPT && parsed.main?.provider !== CLAUDE_CODE) {
        const keys = await deps.keyd.secrets();
        check(c.req.raw.signal);
        const catalog = deps.catalog.get();
        const roles = activeRoles(parsed);
        const active: ResolvedRole[] = [];
        for (const role of ["main", "fast", "local"] as const) {
          const choice = roles[role];
          if (choice) active.push(resolveRole(role, choice, catalog, keys));
        }
        if (active.length) pricingOf(active);
      }
      check(c.req.raw.signal);
      const saved = deps.settings.put(parsed);
      // A task start retries this; until then keyd keeps the daily limit it had.
      await syncDayLimit(deps.keyd, saved.dayBudgetUSD).catch(() =>
        console.error("keyd's daily spending limit could not be updated"),
      );
      return c.json(saved);
    }),
  );
  app.post(
    "/api/cells/:id/agent",
    route(async (c) => {
      const cellId = c.req.param("id") ?? "";
      if (!ULID_PATTERN.test(cellId)) throw new RouteError(400, "invalid computer id");
      const parsed = await json(c.req.raw, Task);
      check(c.req.raw.signal);
      const task = redact(parsed.task, undefined, cellId);
      const grant = c.get("remoteGrant");
      let reservation: ReturnType<import("../remote/links.ts").RemoteLinks["reserve"]> | undefined;
      if (grant) {
        try {
          reservation = deps.remoteLinks?.reserve(grant.id);
        } catch {
          throw new RouteError(403, "This link has reached its task limit or expired.");
        }
        if (!reservation) throw new RouteError(403, "Shared access is unavailable");
      }
      let result: AgentSession;
      const revoked = new AbortController();
      const unsubscribe = grant
        ? deps.remoteLinks?.onRevoke((id) => {
            if (id === grant.id) revoked.abort();
          })
        : undefined;
      try {
        if (grant && !deps.remoteLinks?.active(grant.id))
          throw new RouteError(403, "Shared access ended");
        const startSignal = grant
          ? AbortSignal.any([c.req.raw.signal, revoked.signal])
          : c.req.raw.signal;
        const startOptions = {
          ...(parsed.mode === "research" ? { research: true } : {}),
          ...(parsed.continues !== undefined ? { continues: parsed.continues } : {}),
          ...(reservation
            ? {
                main: reservation.model,
                budgetUSD: Math.min(
                  reservation.budgetUSD,
                  deps.settings.get().taskBudgetUSD ?? reservation.budgetUSD,
                ),
              }
            : {}),
          ...(grant ? { sender: grant.id } : {}),
        };
        result = Object.keys(startOptions).length
          ? await deps.runner.start(cellId, task, startSignal, startOptions)
          : await deps.runner.start(cellId, task, startSignal);
        reservation?.finish(result.id);
        if (grant && !deps.remoteLinks?.active(grant.id)) {
          await deps.runner.stopRun?.(result.id);
          throw new RouteError(403, "Shared access ended");
        }
      } catch (error) {
        reservation?.finish();
        throw error;
      } finally {
        unsubscribe?.();
      }
      check(c.req.raw.signal);
      return c.json({ sessionId: result.id }, 202);
    }),
  );
  const conversations = deps.conversations;
  if (conversations) {
    // Choosing a conversation only changes what the app shows: every task goes on.
    app.get(
      "/api/conversation",
      route((c) => c.json(conversations.snapshot())),
    );
    app.get(
      "/api/conversations",
      route((c) => {
        const listed = conversations.list(undefined, c.req.query("archived") === "1");
        return c.json({
          ...listed,
          conversations: listed.conversations.map((entry) => {
            const live = deps.runner.liveStatus?.(entry.sessionId);
            return live ? { ...entry, live } : entry;
          }),
        });
      }),
    );
    app.post(
      "/api/conversation/new",
      route(async (c) => {
        await empty(c.req.raw);
        conversations.begin();
        return c.json(conversations.snapshot());
      }),
    );
    app.post(
      "/api/conversation/continue",
      route(async (c) => {
        const { sessionId } = await json(c.req.raw, ContinueConversation);
        if (!conversations.select(sessionId)) throw new RouteError(404, "no such task");
        return c.json(conversations.snapshot());
      }),
    );
  }
  app.get(
    "/api/agent/sessions/:id",
    route((c) => {
      const id = c.req.param("id") ?? "";
      if (ULID_PATTERN.test(id)) {
        const terminal = deps.runner.terminalOf?.(id);
        if (terminal) return c.json(terminal);
      }
      const s = session(id);
      const budgetHold = deps.runner.budgetHoldOf?.(s.id);
      return c.json({
        sessionId: s.id,
        cellId: s.cellId,
        status: s.status,
        toolCalls: s.toolCalls,
        autonomy: s.autonomy,
        ...(s.screens ? { screen: s.screens.selection } : {}),
        ...(s.pendingApproval ? { approval: s.pendingApproval } : {}),
        ...(s.connections.pending ? { connection: s.connections.pending } : {}),
        ...(s.safetyPause ? { pause: s.safetyPause } : {}),
        ...(budgetHold ? { budgetHold } : {}),
        ...(deps.runner.selectionOf?.(s.id) ? { models: deps.runner.selectionOf(s.id) } : {}),
        ...(s.brainCellId ? { brainCellId: s.brainCellId } : {}),
        ...(s.pendingAsk ? { pendingAsk: s.pendingAsk } : {}),
        ...(s.pendingTakeover ? { pendingTakeover: s.pendingTakeover } : {}),
        ...(s.manualControl ? { manualControl: s.manualControl } : {}),
        ...(deps.runner.holds?.(s.id) ? { holder: true } : {}),
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
      if (deps.runner.holds?.(s.id))
        throw new RouteError(409, "hand back the computer, then message dot");
      const text = redact(parsed.text, s.id, s.cellId);
      if (s.pendingTakeover) {
        // A deliberate Send hands control back. Publish this instruction before
        // waking the model, so it cannot resume the old plan ahead of the message.
        if (!(await s.handback(s.pendingTakeover, text, c.req.raw.signal)))
          throw new RouteError(409, "The computer is still changing hands. Try sending again.");
      } else if (parsed.kind === "followup") s.enqueue(text, c.get("remoteGrant")?.id);
      else s.post(parsed.kind, text, c.get("remoteGrant")?.id);
      return c.body(null, 202);
    }),
  );
  // One at a time for each task; the answer goes back to the user alone.
  const asking = new Set<string>();
  app.post(
    "/api/agent/sessions/:id/side-question",
    route(async (c) => {
      const id = c.req.param("id") ?? "";
      if (!ULID_PATTERN.test(id)) throw new RouteError(400, "invalid task id");
      const { question } = await json(c.req.raw, SideQuestion);
      const text = redact(question, id, undefined, SIDE_QUESTION_CHARS);
      if (!deps.runner.sideAnswer) throw new RouteError(503, "side questions are unavailable");
      if (asking.has(id)) throw new RouteError(409, "busy");
      asking.add(id);
      const late = AbortSignal.timeout(90_000);
      try {
        return c.json(
          await deps.runner.sideAnswer(id, text, AbortSignal.any([c.req.raw.signal, late])),
        );
      } catch (error) {
        if (error instanceof SideQuestionError) throw new RouteError(error.status, error.problem);
        if (late.aborted) throw new RouteError(502, "no-answer");
        throw error;
      } finally {
        asking.delete(id);
      }
    }),
  );
  app.post(
    "/api/agent/sessions/:id/stop",
    route(async (c) => {
      const id = c.req.param("id") ?? "";
      if (!ULID_PATTERN.test(id)) throw new RouteError(400, "invalid task id");
      // Asked to, Stop gives the stopper back what they said that dot had not acted on.
      const giving = c.req.query("giveBack") === "1";
      const live = giving ? deps.runner.get(id) : undefined;
      const messages = live?.giveBack(c.get("remoteGrant")?.id ?? null) ?? [];
      // A task that carried nothing out leaves its conversation as it was before it, for every
      // viewer as the task ends, and leaves no record once it has settled.
      const emptied = !!live?.emptied;
      if (emptied)
        try {
          conversations?.leave(id);
        } catch {
          console.error("the current conversation could not be saved");
        }
      if (!deps.runner.stopRun || !(await deps.runner.stopRun(id)))
        throw new RouteError(404, "task not found");
      if (emptied)
        try {
          conversations?.discard(id);
        } catch {
          console.error("a task that carried nothing out could not be removed");
        }
      return giving ? c.json({ messages }) : c.body(null, 204);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/messages/:messageId/steer",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const messageId = c.req.param("messageId") ?? "";
      if (!ULID_PATTERN.test(messageId)) throw new RouteError(400, "invalid message id");
      if (!s.steerQueued(messageId)) throw new RouteError(404, "queued message not found");
      return c.body(null, 204);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/messages/:messageId/edit",
    route(async (c) => {
      const id = c.req.param("id") ?? "";
      const messageId = c.req.param("messageId") ?? "";
      if (!ULID_PATTERN.test(messageId)) throw new RouteError(400, "invalid message id");
      check(c.req.raw.signal);
      const live = ULID_PATTERN.test(id) ? deps.runner.get(id) : undefined;
      let text = live?.withdrawQueued(messageId);
      // One Stop left unsent comes back from the task's record, after a restart too.
      if (text === undefined && (!live || live.stopped))
        text = deps.conversations?.withdrawStopped(id, messageId);
      if (text !== undefined) return c.json({ text });
      if (!live && !deps.conversations?.has(id)) throw new RouteError(404, "no such task");
      throw new RouteError(409, "message is no longer queued");
    }),
  );
  app.post(
    "/api/agent/sessions/:id/messages/:messageId/cancel",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const messageId = c.req.param("messageId") ?? "";
      if (!ULID_PATTERN.test(messageId)) throw new RouteError(400, "invalid message id");
      check(c.req.raw.signal);
      if (!s.cancelQueued(messageId)) throw new RouteError(409, "message is no longer queued");
      return c.body(null, 204);
    }),
  );
  // The user's word on a research task's budget: wrap up now, or keep going for longer.
  app.post(
    "/api/agent/sessions/:id/research",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const { change } = await json(c.req.raw, ResearchChange);
      check(c.req.raw.signal);
      if (!s.research) throw new RouteError(409, "this task is not research");
      if (change === "wrap_up") s.research.wrapUp();
      else s.research.more();
      s.remind(`(${s.research.stopped ? s.research.stopNote() : s.research.moreNote()})`);
      return c.body(null, 204);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/approvals/answer",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const generation = s.generation;
      const parsed = await json(c.req.raw, ApprovalAnswer);
      check(c.req.raw.signal);
      // A connection's card is no step of the agent's: it is answered whatever the brain is doing.
      if (s.connections.owns(parsed.approvalId))
        return s.connections.answer(parsed)
          ? c.body(null, 204)
          : c.text("approval is not waiting", 409);
      if (!generation || s.controlHeld) throw new RouteError(409, "approval is not waiting");
      if (!s.isCurrent(generation) || s.controlHeld)
        throw new RouteError(409, "approval owner changed");
      return s.answerApproval(parsed) ? c.body(null, 204) : c.text("approval is not waiting", 409);
    }),
  );
  const rules = new RulesStore(deps.home);
  app.get(
    "/api/agent/rules",
    route((c) => c.json(rules.list())),
  );
  app.post(
    "/api/agent/rules/reset",
    route(async (c) => {
      await empty(c.req.raw);
      check(c.req.raw.signal);
      rules.setAside();
      return c.body(null, 204);
    }),
  );
  app.delete(
    "/api/agent/rules/:id",
    route(async (c) => {
      const id = c.req.param("id") ?? "";
      if (!ULID_PATTERN.test(id)) throw new RouteError(400, "invalid rule id");
      await empty(c.req.raw);
      check(c.req.raw.signal);
      const rule = rules.remove(id);
      if (!rule) throw new RouteError(404, "no such rule");
      for (const s of deps.runner.sessions?.values() ?? [])
        if (!s.stopped) s.append("rule.removed", ruleChange(rule));
      return c.body(null, 204);
    }),
  );
  app.delete(
    "/api/agent/sessions/:id/allowances/:actionClass",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const actionClass = ActionClass.safeParse(c.req.param("actionClass"));
      if (!actionClass.success) throw new RouteError(400, "invalid action class");
      await empty(c.req.raw);
      check(c.req.raw.signal);
      const change = s.taskAutonomy.revoke(actionClass.data, c.req.query("destination"));
      if (!change) throw new RouteError(404, "nothing is allowed for that in this task");
      s.append("rule.removed", change);
      return c.body(null, 204);
    }),
  );
  app.get(
    "/api/agent/sessions/:id/approvals/:approvalId/fields/:field",
    route((c) => {
      const s = session(c.req.param("id") ?? "");
      const field = c.req.param("field") ?? "";
      const text = /^(?:\d|1[0-5])$/.test(field)
        ? s.approvalField(c.req.param("approvalId") ?? "", Number(field))
        : undefined;
      if (text === undefined) throw new RouteError(404, "that approval text is not waiting");
      c.header("cache-control", "no-store");
      return c.json({ text });
    }),
  );
  app.post(
    "/api/agent/sessions/:id/answer",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const parsed = await json(c.req.raw, QuestionAnswerRequest);
      check(c.req.raw.signal);
      if (parsed.fields && s.pendingAsk === parsed.askId) {
        for (const field of s.requestedCredentials(parsed.askId)) {
          if (field.kind !== "api_key") continue;
          if (parsed.fields[field.id] !== true || !field.credential)
            return c.text("Save this key before continuing", 409);
          const keys = await deps.keyd.secrets();
          if (!keys.some((key) => sameCredential(key, field.credential!.binding)))
            return c.text("The requested key has not been saved", 409);
          check(c.req.raw.signal);
        }
      }
      // Every question is asked with fields; a lettered option or text answers none of them.
      const ok = parsed.declined
        ? s.decline(parsed.askId)
        : !!parsed.fields &&
          s.answerFields(parsed.askId, parsed.fields, (text) => redact(text, s.id, s.cellId));
      return ok ? c.body(null, 204) : c.text("that question is not waiting", 409);
    }),
  );
  // The user takes the computer whatever dot is doing; the reply names the control to hand back.
  app.post(
    "/api/agent/sessions/:id/takeover",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      await empty(c.req.raw);
      check(c.req.raw.signal);
      // A hold the user handed back is ending; the computer's own route starts the next one.
      if (
        s.stopped ||
        deps.taskMutationReady?.(s) === false ||
        (deps.runner.holds?.(s.id) && !s.controlHeld)
      )
        throw new RouteError(409, "the computer is not ready to hand over");
      return c.json({ requestId: s.takeControl() } satisfies TakeControlReply, 202);
    }),
  );
  // The user takes the computer whether or not a task is at work on it.
  app.post(
    "/api/cells/:id/takeover",
    route(async (c) => {
      const cellId = c.req.param("id") ?? "";
      if (!ULID_PATTERN.test(cellId)) throw new RouteError(400, "invalid computer id");
      await empty(c.req.raw);
      check(c.req.raw.signal);
      if (!deps.runner.hold) throw new RouteError(503, "taking control is unavailable");
      const reply = await deps.runner.hold(cellId, c.req.raw.signal);
      return c.json(reply satisfies TakeComputerReply, 202);
    }),
  );
  // Settings > Accounts: the web browser opens the site's sign-in page and the user takes it there.
  app.post(
    "/api/cells/:id/accounts/sign-in",
    route(async (c) => {
      const cellId = c.req.param("id") ?? "";
      if (!ULID_PATTERN.test(cellId)) throw new RouteError(400, "invalid computer id");
      const host = signInSite((await json(c.req.raw, SignInRequest)).site);
      check(c.req.raw.signal);
      if (!host) throw new RouteError(400, "that isn't a site the web browser can open");
      if (!deps.runner.signIn) throw new RouteError(503, "signing in is unavailable");
      const reply = await deps.runner.signIn(cellId, host, signInUrl(host), c.req.raw.signal);
      return c.json(reply satisfies TakeComputerReply, 202);
    }),
  );
  // The site whose sign-in the desktop's own browser shows, which isn't kept there.
  app.get(
    "/api/cells/:id/desktop-sign-in",
    route(async (c) => {
      const cellId = c.req.param("id") ?? "";
      if (!ULID_PATTERN.test(cellId)) throw new RouteError(400, "invalid computer id");
      const url = await deps.desktopPage?.(cellId, c.req.raw.signal).catch(() => undefined);
      check(c.req.raw.signal);
      return c.json({ site: (url && desktopSignIn(url)) || null } satisfies DesktopSignIn);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/takeover/done",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const parsed = await json(c.req.raw, HandbackRequest);
      check(c.req.raw.signal);
      const ok = await s.handback(
        parsed.requestId,
        parsed.note === undefined ? undefined : redact(parsed.note, s.id, s.cellId, 1000),
        c.req.raw.signal,
        parsed.declined === true,
      );
      return ok ? c.body(null, 204) : c.text("the screen is not handed over", 409);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/takeover/sign-in",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const parsed = await json(c.req.raw, UserBrowserSignInRequest);
      const lease = s.admitManual(parsed.requestId, c.req.raw.signal);
      let access: ReturnType<NonNullable<typeof s.screens>["manualAccess"]> | undefined;
      try {
        if (!s.screens) throw new RouteError(503, "browser sign-in is unavailable");
        access = s.screens.manualAccess({ signal: lease.signal, check: lease.check });
        const result = await access.signIn(parsed.action === "start");
        lease.check();
        return c.json(UserBrowserSignInReply.parse(result));
      } finally {
        access?.finish();
        lease.finish();
      }
    }),
  );
  app.post(
    "/api/agent/sessions/:id/takeover/input",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const parsed = await json(c.req.raw, TakeoverInputRequest);
      check(c.req.raw.signal);
      await sendManualInput(s, parsed, c.req.raw.signal, deps.manual);
      check(c.req.raw.signal);
      return c.body(null, 204);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/budget",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const parsed = await json(c.req.raw, Budget);
      check(c.req.raw.signal);
      if (s.stopped || s.controlHeld || s.pendingAsk || deps.taskMutationReady?.(s) === false)
        throw new RouteError(409, "task is not available to change its budget");
      await deps.runner.raiseBudget(s.id, parsed.budgetUSD);
      check(c.req.raw.signal);
      return c.body(null, 204);
    }),
  );
  // The dot this task works as, when the user changes the one Auto chose.
  app.post(
    "/api/agent/sessions/:id/persona",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const { persona } = await json(c.req.raw, z.strictObject({ persona: PersonaId }));
      check(c.req.raw.signal);
      if (!deps.runner.switchPersona) throw new RouteError(503, "Changing dot is unavailable");
      try {
        deps.runner.switchPersona(s.id, persona);
      } catch (error) {
        if (error instanceof AgentError) throw new RouteError(409, error.message);
        throw error;
      }
      return c.body(null, 204);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/pause",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      const input = await json(c.req.raw, PauseRequest);
      check(c.req.raw.signal);
      if (!deps.runner.pauseTask) throw new RouteError(503, "Pause is unavailable");
      return c.json(deps.runner.pauseTask(s.id, input.requestId), 202);
    }),
  );
  app.post(
    "/api/agent/sessions/:id/resume",
    route(async (c) => {
      const s = active(c.req.param("id") ?? "");
      if (s.safetyPause) {
        const input = await json(c.req.raw, ResumeSafetyRequest);
        check(c.req.raw.signal);
        if (!deps.runner.resumeSafety) throw new RouteError(503, "Safety Resume is unavailable");
        if (deps.runner.budgetHoldOf?.(s.id) === "task")
          throw new RouteError(409, RAISE_BUDGET_FIRST);
        await deps.runner.resumeSafety(s.id, input.requestId, input.revision);
        return c.body(null, 204);
      }
      await empty(c.req.raw);
      check(c.req.raw.signal);
      if (
        s.stopped ||
        s.controlHeld ||
        s.pendingAsk ||
        s.status !== "paused" ||
        deps.taskMutationReady?.(s) === false
      )
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
        name.startsWith(".") ||
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
      let submitted = false;
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
        submitted = true;
        const path = await access.tools.putFile(
          `Downloads/${name}`,
          body,
          undefined,
          access.signal,
          true, // User attachments never replace an existing Downloads file.
        );
        access.check();
        check(access.signal);
        check(request.signal);
        if (oversized) throw new RouteError(413, "file too large");
        return c.json({ path }, 201);
      } catch (error) {
        if (oversized) throw new RouteError(413, "file too large");
        // A control/readiness interruption after submission may follow durable
        // publication. A verified desktop no-replace conflict remains a refusal.
        if (
          submitted &&
          (error instanceof ControlHeldError ||
            error instanceof SessionStoppedError ||
            (error instanceof AgentError && error.status === 409) ||
            (error instanceof RouteError && error.status === 409))
        )
          throw new RouteError(499, "upload completion could not be confirmed");
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
  const writable = () => {
    if (deps.canChangeMemory?.() === false)
      throw new RouteError(503, "memory is not available to change");
  };
  const changed = (file: string) => {
    if (NOTES_FILE.test(file)) deps.notesChanged?.(file);
  };
  app.post(
    "/api/agent/memory/:changeId/undo",
    route(async (c) => {
      const changeId = c.req.param("changeId") ?? "";
      if (!ULID_PATTERN.test(changeId)) throw new RouteError(400, "invalid memory change id");
      await empty(c.req.raw);
      check(c.req.raw.signal);
      writable();
      const change = deps.memory.undo(changeId);
      changed(change.file);
      if (change.sessionId)
        deps.appendTo(change.sessionId, "memory.change", {
          file: change.file,
          patch: change.patch,
          changeId: change.changeId,
          undoes: change.undoes,
        });
      return c.json({ changeId: change.changeId });
    }),
  );
  const titles = (sources: readonly ({ kind: string } & { sessionId?: string })[]) =>
    deps.sessionInfo?.([
      ...new Set(sources.flatMap((s) => (s.kind === "task" && s.sessionId ? [s.sessionId] : []))),
    ]) ?? new Map<string, { title: string | null }>();
  const titled = <T extends { source: StoredEntry["source"] | StoredPerson["source"] }>(
    item: T,
    info: Map<string, { title: string | null }>,
  ) => ({
    ...item,
    source:
      item.source.kind === "task"
        ? {
            kind: "task" as const,
            sessionId: item.source.sessionId,
            title: info.get(item.source.sessionId)?.title ?? null,
          }
        : item.source,
  });
  const idParam = (c: Context, pattern: RegExp) => {
    const id = c.req.param("id") ?? "";
    if (!pattern.test(id)) throw new RouteError(400, "invalid id");
    return id;
  };
  app.get(
    "/api/agent/memory/entries",
    route((c) => {
      const files = (["USER.md", "MEMORY.md"] as const).map((file) => ({
        file,
        entries: deps.memory.entries(file),
      }));
      const notes = deps.memory.notes();
      const info = titles([...files, ...notes].flatMap((f) => f.entries.map((e) => e.source)));
      const shown = (f: { file: string; entries: StoredEntry[] }) => ({
        file: f.file,
        entries: f.entries.map((e) => titled(e, info)),
      });
      return c.json(
        MemoryEntriesReply.parse({
          dir: join(deps.home, "memory").replace(homedir(), "~"),
          files: files.map(shown),
          notes: notes.map(shown),
        }),
      );
    }),
  );
  app.post(
    "/api/agent/memory/entries",
    route(async (c) => {
      const body = await json(c.req.raw, AddMemoryEntryRequest);
      writable();
      const { change, entry } = deps.memory.addEntry(body.file, body.text, body.pinned ?? false);
      return c.json(
        MemoryEntryChangeReply.parse({
          changeId: change.changeId,
          entry: titled(entry, titles([entry.source])),
        }),
        201,
      );
    }),
  );
  app.put(
    "/api/agent/memory/entries/:id",
    route(async (c) => {
      const id = idParam(c, MEMORY_ENTRY_ID);
      const body = await json(c.req.raw, EditMemoryEntryRequest);
      writable();
      const { change, entry } = deps.memory.editEntry(body.file, id, body.revision, {
        ...(body.text === undefined ? {} : { text: body.text }),
        ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
      });
      changed(body.file);
      return c.json(
        MemoryEntryChangeReply.parse({
          changeId: change.changeId,
          entry: titled(entry, titles([entry.source])),
        }),
      );
    }),
  );
  app.delete(
    "/api/agent/memory/entries/:id",
    route(async (c) => {
      const id = idParam(c, MEMORY_ENTRY_ID);
      const file = MemoryFileName.safeParse(c.req.query("file"));
      const revision = MemoryEntryRevision.safeParse(c.req.query("revision"));
      if (!file.success || !revision.success) throw new RouteError(400, "invalid memory entry");
      await empty(c.req.raw);
      writable();
      const { change } = deps.memory.deleteEntry(file.data, id, revision.data);
      changed(file.data);
      return c.json(MemoryEntryChangeReply.parse({ changeId: change.changeId }));
    }),
  );
  const people = deps.people;
  if (people) {
    const personView = (person: StoredPerson) =>
      Person.parse(titled(person, titles([person.source])));
    app.get(
      "/api/agent/people",
      route((c) => {
        const list = people.list();
        const info = titles(list.map((p) => p.source));
        return c.json(PeopleReply.parse({ people: list.map((p) => titled(p, info)) }));
      }),
    );
    app.post(
      "/api/agent/people",
      route(async (c) => {
        const body = await json(c.req.raw, AddPersonRequest);
        writable();
        return c.json(PersonChangeReply.parse({ person: personView(people.add(body)) }), 201);
      }),
    );
    app.put(
      "/api/agent/people/:id",
      route(async (c) => {
        const id = idParam(c, ULID_PATTERN);
        const { revision, ...patch } = await json(c.req.raw, EditPersonRequest);
        writable();
        return c.json(
          PersonChangeReply.parse({ person: personView(people.edit(id, revision, patch)) }),
        );
      }),
    );
    app.delete(
      "/api/agent/people/:id",
      route(async (c) => {
        const id = idParam(c, ULID_PATTERN);
        const revision = PersonRevision.safeParse(c.req.query("revision"));
        if (!revision.success) throw new RouteError(400, "invalid person");
        await empty(c.req.raw);
        writable();
        people.remove(id, revision.data);
        return c.json(PersonChangeReply.parse({}));
      }),
    );
  }
  const recent = deps.recentActivity;
  if (recent)
    app.get(
      "/api/agent/recent-activity",
      route((c) =>
        c.json(
          RecentActivityReply.parse({
            enabled: deps.settings.get().recentActivity !== "off",
            tasks: recent(),
          }),
        ),
      ),
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
