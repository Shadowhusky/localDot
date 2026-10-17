import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexInstallState, InstalledCodex } from "@localdot/codex-harness";
import { type ChatgptSandbox, type KeydRecord, ulid } from "@localdot/protocol";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addToolRoutes } from "../../../../cells/desktop/desktopd/src/tools/routes.ts";
import { createApp } from "../app.ts";
import { DesktopdTools } from "../desktopd/tools-client.ts";
import { EventLog } from "../event-log.ts";
import { KeydUnavailableError } from "../keyd/client.ts";
import { CatalogStore } from "./catalog-store.ts";
import type { ChatgptStatus } from "./codex/account.ts";
import { SANDBOX_REASONS } from "./codex/setup.ts";
import { TRANSFER_BYTES } from "./download.ts";
import { MemoryStore } from "./memory.ts";
import { ResearchLog } from "./research.ts";
import { type AgentRoutesDeps, agentRoutes } from "./routes.ts";
import { AgentError, type TaskStartOptions } from "./runner.ts";
import { AgentSession } from "./session.ts";
import { SettingsStore } from "./settings.ts";

const CELL = "01JXYZ0000000000000000CE11";
const SESSION = "01JXYZ0000000000000000SESS";
const at = "2026-10-02T00:00:00Z";
const owned: { home: string; session: AgentSession }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.session.stop();
    rmSync(item.home, { recursive: true, force: true });
  }
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(options: Pick<AgentRoutesDeps, "chatgpt" | "harness" | "claudeCode"> = {}) {
  const home = mkdtempSync(join(tmpdir(), "localdot-agent-routes-"));
  const events: { type: string; data: unknown }[] = [];
  const session = new AgentSession(SESSION, CELL, "task", {
    append: (_id, event) => {
      events.push(event);
      return undefined as never;
    },
  });
  session.beginBrain();
  session.status = "running";
  owned.push({ home, session });
  const catalog = new CatalogStore(home, {
    fetchImpl: async () => Response.json(MODELS_DEV_FIXTURE),
  });
  await catalog.refresh();
  const settings = new SettingsStore(home);
  const memory = new MemoryStore(home);
  const keys: KeydRecord[] = [
    { id: "anthropic", kind: "llm", provider: "anthropic", createdAt: at, updatedAt: at },
  ];
  const lifetime = new AbortController();
  let transferred = 0;
  const put = vi.fn(
    async (
      path: string,
      source: ReadableStream<Uint8Array>,
      _mode?: number,
      signal?: AbortSignal,
      _createOnly?: boolean,
    ) => {
      const reader = source.getReader();
      try {
        for (;;) {
          signal?.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          transferred += part.value.byteLength;
        }
        return `~/${path}`;
      } finally {
        reader.releaseLock();
      }
    },
  );
  const release = vi.fn();
  const start = vi.fn(
    async (_cell: string, _task: string, _signal?: AbortSignal, _options?: TaskStartOptions) =>
      session,
  );
  const raise = vi.fn(async (_id: string, _budget: number) => {});
  const redact = vi.fn((text: string) => text.replaceAll("credential-fixture", "[redacted]"));
  const deps: AgentRoutesDeps = {
    ...options,
    runner: { start, get: (id) => (id === SESSION ? session : undefined), raiseBudget: raise },
    settings,
    catalog,
    keyd: { secrets: vi.fn(async () => keys) },
    memory,
    skills: () => [],
    home,
    desktop: vi.fn((_id, requestSignal) => {
      if (session.controlHeld || session.stopped) return undefined;
      const signal = AbortSignal.any([lifetime.signal, requestSignal, session.abort.signal]);
      return { tools: { putFile: put }, signal, check: () => signal.throwIfAborted(), release };
    }),
    redactUserText: redact,
    appendTo: (_id, type, data) => {
      events.push({ type, data });
    },
  };
  const app = new Hono();
  agentRoutes(app, deps);
  const send = (method: string, path: string, body?: unknown, signal?: AbortSignal) =>
    app.request(`http://fixture${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  const stream = (
    path: string,
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
    headers?: RequestInit["headers"],
  ) =>
    app.request(
      new Request(`http://fixture${path}`, {
        method: "POST",
        body,
        duplex: "half",
        signal,
        headers,
      } as RequestInit),
    );
  return {
    app,
    send,
    stream,
    home,
    session,
    events,
    deps,
    start,
    raise,
    redact,
    lifetime,
    put,
    release,
    get transferred() {
      return transferred;
    },
    settings,
    memory,
  };
}
const endpoint = (name: string) => `/api/agent/sessions/${SESSION}/${name}`;

describe("agent user routes", () => {
  it("exposes purpose diagnostics without running tests on read", async () => {
    const f = await setup();
    const status = {
      mode: "bypassed" as const,
      host: "api.typesafe.ai" as const,
      model: "jev-latest" as const,
      calls: 0,
      succeeded: 0,
      failed: 0,
    };
    f.deps.purpose = { status: vi.fn(async () => status), test: vi.fn(async () => status) };
    expect(await (await f.send("GET", "/api/agent/purpose-check")).json()).toEqual(status);
    expect(f.deps.purpose.test).not.toHaveBeenCalled();
    expect((await f.send("POST", "/api/agent/purpose-check/test")).status).toBe(200);
    expect(f.deps.purpose.test).toHaveBeenCalledTimes(1);
  });
  it("rejects a forged remote local-role selection before persisting or starting a task", async () => {
    const f = await setup();
    const document = {
      main: { provider: "ollama", model: "local" },
      local: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
    };
    expect((await f.send("PUT", "/api/agent/settings", document)).status).toBe(400);
    expect(f.settings.get()).toEqual({});
    expect(f.start).not.toHaveBeenCalled();
  });
  it("gives keyd the user's daily spending limit when settings are saved, and none without one", async () => {
    const f = await setup();
    const day = { date: "2026-10-09", spentUSD: 1 };
    let limits = { perTaskUSD: 5, perDayUSD: 20 };
    f.deps.keyd.budget = vi.fn(async () => ({ ...limits, day }));
    const setBudget = vi.fn(async (perTaskUSD: number, perDayUSD: number) => {
      limits = { perTaskUSD, perDayUSD };
      return { ...limits, day };
    });
    f.deps.keyd.setBudget = setBudget;
    const document = { main: { provider: "ollama", model: "local" } };
    expect((await f.send("PUT", "/api/agent/settings", document)).status).toBe(200);
    expect(setBudget).toHaveBeenLastCalledWith(0, 0);
    const limited = { ...document, taskBudgetUSD: 2, dayBudgetUSD: 12 };
    expect((await f.send("PUT", "/api/agent/settings", limited)).status).toBe(200);
    expect(setBudget).toHaveBeenLastCalledWith(0, 12);
    expect(f.settings.get()).toEqual(limited);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("requires both explicit finite remote prices at the real settings route and preserves accepted settings on every refusal", async () => {
    const f = await setup();
    const keys = [
      {
        id: "gateway",
        kind: "llm" as const,
        provider: "openai-compatible",
        baseURL: "https://example.test/v1",
        createdAt: at,
        updatedAt: at,
      },
    ];
    (f.deps.keyd.secrets as ReturnType<typeof vi.fn>).mockResolvedValue(keys);
    const initial = {
      main: { provider: "ollama", model: "local" },
      codexDenyRead: ["/private/fixture"],
      taskBudgetUSD: 2,
    };
    expect((await f.send("PUT", "/api/agent/settings", initial)).status).toBe(200);
    const choice = { provider: "openai-compatible", model: "custom", key: "gateway" };
    for (const price of [
      undefined,
      {},
      { inputUSDPerMTok: 1 },
      { outputUSDPerMTok: 1 },
      { inputUSDPerMTok: "0", outputUSDPerMTok: 1 },
      { inputUSDPerMTok: NaN, outputUSDPerMTok: 1 },
      { inputUSDPerMTok: Infinity, outputUSDPerMTok: 1 },
      { inputUSDPerMTok: -1, outputUSDPerMTok: 1 },
      { inputUSDPerMTok: 10_001, outputUSDPerMTok: 1 },
      { inputUSDPerMTok: 0, outputUSDPerMTok: 0 },
    ]) {
      const response = await f.send("PUT", "/api/agent/settings", {
        ...initial,
        main: { ...choice, ...(price === undefined ? {} : { price }) },
      });
      expect(response.status, JSON.stringify(price)).toBe(400);
      expect(f.settings.get()).toEqual(initial);
    }
    const overflow = await f.app.request("http://fixture/api/agent/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '{"main":{"provider":"openai-compatible","model":"custom","key":"gateway","price":{"inputUSDPerMTok":1e999,"outputUSDPerMTok":1}}}',
    });
    expect(overflow.status).toBe(400);
    expect(f.settings.get()).toEqual(initial);
    for (const price of [
      { inputUSDPerMTok: 0, outputUSDPerMTok: 2 },
      { inputUSDPerMTok: 1, outputUSDPerMTok: 0 },
    ]) {
      const next = { ...initial, main: { ...choice, price } };
      const response = await f.send("PUT", "/api/agent/settings", next);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject(next);
      expect(f.settings.get()).toMatchObject(next);
      expect(f.settings.get().models).toContainEqual(initial.main);
    }
    const before = f.settings.get();
    (f.deps.keyd.secrets as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    expect((await f.send("PUT", "/api/agent/settings", before)).status).toBe(400);
    (f.deps.keyd.secrets as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...keys[0], provider: "openai" },
    ]);
    expect((await f.send("PUT", "/api/agent/settings", before)).status).toBe(400);
    expect(f.settings.get()).toEqual(before);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("saves what a custom endpoint's model can do, and refuses it for a catalog model", async () => {
    const f = await setup();
    (f.deps.keyd.secrets as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "anthropic", kind: "llm", provider: "anthropic", createdAt: at, updatedAt: at },
      {
        id: "anc",
        kind: "llm",
        provider: "anthropic-compatible",
        baseURL: "https://api.z.ai/api/anthropic/v1",
        createdAt: at,
        updatedAt: at,
      },
    ]);
    const stated = {
      main: {
        provider: "anthropic-compatible",
        model: "glm-5.3-flash",
        key: "anc",
        vision: false,
        contextTokens: 128_000,
        plan: true,
      },
    };
    expect((await f.send("PUT", "/api/agent/settings", stated)).status).toBe(200);
    expect(f.settings.get()).toEqual(stated);
    for (const extra of [{ vision: false }, { contextTokens: 128_000 }, { plan: true }])
      expect(
        (
          await f.send("PUT", "/api/agent/settings", {
            main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic", ...extra },
          })
        ).status,
      ).toBe(400);
    expect(f.settings.get()).toEqual(stated);
  });
  it("refuses conflicting rates for the same active route/model before persisting settings", async () => {
    const f = await setup();
    (f.deps.keyd.secrets as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "gateway",
        kind: "llm",
        provider: "openai-compatible",
        baseURL: "https://example.test/v1",
        createdAt: at,
        updatedAt: at,
      },
    ]);
    const main = {
      provider: "openai-compatible",
      model: "custom",
      key: "gateway",
      price: { inputUSDPerMTok: 1, outputUSDPerMTok: 2 },
    };
    const accepted = { main, fast: main };
    expect((await f.send("PUT", "/api/agent/settings", accepted)).status).toBe(200);
    expect(
      (
        await f.send("PUT", "/api/agent/settings", {
          main,
          fast: { ...main, price: { inputUSDPerMTok: 3, outputUSDPerMTok: 2 } },
        })
      ).status,
    ).toBe(400);
    expect(f.settings.get()).toEqual(accepted);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("downloads model metadata on the first provider read without needing a key", async () => {
    const f = await setup();
    rmSync(join(f.home, "catalog"), { recursive: true });
    const refresh = vi.fn(async () => Response.json(MODELS_DEV_FIXTURE));
    f.deps.catalog = new CatalogStore(f.home, { fetchImpl: refresh });
    (f.deps.keyd.secrets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const reply = await f.send("GET", "/api/agent/providers");
    expect(reply.status).toBe(200);
    const body = (await reply.json()) as {
      catalog: unknown;
      keys: unknown[];
      providers: { id: string; models: unknown[] }[];
    };
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      body.providers.find((p: { id: string }) => p.id === "deepseek")?.models.length,
    ).toBeGreaterThan(0);
    expect(body.keys).toEqual([]);
  });

  it("keeps local and plan setup accessible when the first catalog download fails", async () => {
    const f = await setup();
    rmSync(join(f.home, "catalog"), { recursive: true });
    f.deps.catalog = new CatalogStore(f.home, {
      fetchImpl: async () => {
        throw new Error("timeout");
      },
    });
    const reply = await f.send("GET", "/api/agent/providers");
    expect(reply.status).toBe(200);
    const body = (await reply.json()) as {
      catalog: unknown;
      keys: unknown[];
      providers: { id: string; models: unknown[] }[];
    };
    expect(body.catalog).toBeNull();
    expect(body.providers.find((p: { id: string }) => p.id === "ollama")).toBeDefined();
    expect(body.keys).toHaveLength(1);
  });

  it("lists only LLM key metadata and reports keyd offline without changing the provider list", async () => {
    const f = await setup();
    const res = await f.send("GET", "/api/agent/providers");
    const body = (await res.json()) as {
      keys: unknown[];
      providers: { id: string; models: unknown[] }[];
    };
    expect(body.keys).toEqual([{ id: "anthropic", provider: "anthropic" }]);
    expect(
      body.providers.find((p: { id: string }) => p.id === "anthropic")?.models.length,
    ).toBeGreaterThan(0);
    (f.deps.keyd.secrets as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new KeydUnavailableError("credential-fixture", "/private"),
    );
    const offline = (await (await f.send("GET", "/api/agent/providers")).json()) as {
      keyLayer: string;
      keys: unknown[];
      providers: unknown[];
    };
    expect(offline.keyLayer).toBe("offline");
    expect(offline.keys).toEqual([]);
    expect(offline.providers).toEqual(body.providers);
  });
  it("marks plans, their rule and the plans not offered, which list no models", async () => {
    const f = await setup();
    const body = (await (await f.send("GET", "/api/agent/providers")).json()) as {
      providers: {
        id: string;
        baseURL?: string;
        plan?: true;
        rule?: string;
        notOffered?: string;
        models: { id: string }[];
      }[];
    };
    const row = (id: string) => body.providers.find((p) => p.id === id);
    expect(row("minimax-coding-plan")).toMatchObject({
      plan: true,
      baseURL: "https://api.minimax.io/v1",
      models: [{ id: "MiniMax-M3" }],
    });
    expect(row("minimax-coding-plan")).not.toHaveProperty("rule");
    expect(row("alibaba-coding-plan")).toMatchObject({
      plan: true,
      rule: "Alibaba allows this plan only for tasks you start and watch.",
    });
    expect(row("zai")).not.toHaveProperty("plan");
    expect(row("zai")?.models.map((m) => m.id)).toEqual(["glm-5v-turbo", "glm-4.6v"]);
    const refused = body.providers.filter((p) => p.notOffered);
    expect(refused.map((p) => p.id)).toEqual([
      "zai-coding-plan",
      "kimi-code-plan-global",
      "volcengine-coding-plan",
    ]);
    for (const p of refused) {
      expect(p.notOffered).toMatch(/ API key here instead\.$/);
      expect(p.models).toEqual([]);
      expect(p).not.toHaveProperty("baseURL");
    }
  });
  it("validates all settings roles and refuses writes after cancellation during key lookup", async () => {
    const f = await setup();
    const choice = {
      main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
      taskBudgetUSD: 2,
    };
    expect((await f.send("PUT", "/api/agent/settings", choice)).status).toBe(200);
    expect((await f.send("PUT", "/api/agent/settings", { ...choice, extra: 1 })).status).toBe(400);
    const ready = deferred<KeydRecord[]>();
    (f.deps.keyd.secrets as ReturnType<typeof vi.fn>).mockReturnValueOnce(ready.promise);
    const stop = new AbortController();
    const pending = f.send("PUT", "/api/agent/settings", { taskBudgetUSD: 3 }, stop.signal);
    await Promise.resolve();
    await Promise.resolve();
    stop.abort();
    ready.resolve([]);
    expect((await pending).status).toBe(499);
    expect(f.settings.get()).toEqual(choice);
  });
  it("redacts accepted task/message/answer/handback text before it can reach persistence", async () => {
    const f = await setup();
    expect(
      (await f.send("POST", `/api/cells/${CELL}/agent`, { task: "do credential-fixture" })).status,
    ).toBe(202);
    expect(f.start.mock.calls[0]?.[1]).toBe("do [redacted]");
    expect(f.start.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(
      (
        await f.send("POST", endpoint("messages"), {
          kind: "steer",
          text: "  credential-fixture  ",
        })
      ).status,
    ).toBe(202);
    expect(f.events.at(-1)?.data).toMatchObject({ text: "  [redacted]  " });
    const asking = f.session.ask("which", [], true, 0);
    const askId = f.session.pendingAsk;
    expect(
      (await f.send("POST", endpoint("answer"), { askId, text: "credential-fixture" })).status,
    ).toBe(204);
    expect(await asking).toMatchObject({ text: "[redacted]", by: "user" });
    const taking = f.session.takeover("login", "note");
    await Promise.resolve();
    await Promise.resolve();
    const requestId = f.session.pendingTakeover;
    expect(
      (await f.send("POST", endpoint("takeover/done"), { requestId, note: "credential-fixture" }))
        .status,
    ).toBe(204);
    expect(await taking).toMatchObject({ note: "[redacted]", by: "user" });
    expect(JSON.stringify(f.events)).not.toContain("credential-fixture");
  });
  it("takes field answers and declines, keeping secret answers out of every event", async () => {
    const f = await setup();
    const secret = "credential-fixture and the rest";
    const asking = f.session.askFields(
      {
        question: "Sign in",
        fields: [
          { id: "email", kind: "text", label: "Email" },
          { id: "password", kind: "secret", label: "Password" },
        ],
      },
      0,
    );
    const askId = f.session.pendingAsk;
    expect((await f.send("POST", endpoint("answer"), { askId, text: "hi" })).status).toBe(409);
    expect(
      (await f.send("POST", endpoint("answer"), { askId, fields: { email: "ada" } })).status,
    ).toBe(409);
    expect(
      (
        await f.send("POST", endpoint("answer"), {
          askId,
          fields: { email: "credential-fixture", password: secret },
        })
      ).status,
    ).toBe(204);
    const answer = await asking;
    expect(answer.fields).toEqual({ email: "[redacted]", password: { provided: true } });
    expect(answer.secrets?.take("password")).toBe(secret);
    expect(JSON.stringify(f.events)).not.toContain("credential-fixture");
    const plain = f.session.ask("Which?", ["One", "Two"], false, 0);
    expect(
      (await f.send("POST", endpoint("answer"), { askId: f.session.pendingAsk, declined: true }))
        .status,
    ).toBe(204);
    expect(await plain).toEqual({ declined: true, by: "user" });
  });
  it("a message hands control back and reaches the model as steering before it resumes", async () => {
    const f = await setup();
    const taking = f.session.takeover("login", "note");
    await Promise.resolve();
    await Promise.resolve();
    const requestId = f.session.pendingTakeover;
    expect(
      (await f.send("POST", endpoint("messages"), { kind: "followup", text: "next" })).status,
    ).toBe(202);
    expect(f.session.controlHeld).toBe(false);
    expect(await taking).toEqual({ by: "user", note: "next" });
    expect(f.events.findLast((event) => event.type === "message.user")?.data).toMatchObject({
      kind: "steer",
      text: "next",
    });
    expect((await f.send("POST", endpoint("takeover/done"), { requestId })).status).toBe(409);
  });
  it("validates answer, budget precision, stopped state and rejects raw schema/dependency error details", async () => {
    const f = await setup();
    for (const body of [
      { askId: SESSION },
      { askId: SESSION, text: " " },
      { askId: SESSION, option: "Z" },
    ])
      expect((await f.send("POST", endpoint("answer"), body)).status).toBe(400);
    for (const budgetUSD of [0, 0.0000001, 10001])
      expect((await f.send("POST", endpoint("budget"), { budgetUSD })).status).toBe(400);
    expect(f.raise).not.toHaveBeenCalled();
    expect((await f.send("POST", endpoint("budget"), { budgetUSD: 0.000001 })).status).toBe(204);
    f.start.mockRejectedValueOnce(new AgentError(400, "credential-fixture"));
    const failed = await f.send("POST", `/api/cells/${CELL}/agent`, { task: "go" });
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain("credential-fixture");
    expect(f.start).toHaveBeenCalledTimes(1);
    f.session.stop();
    expect((await f.send("POST", endpoint("messages"), { kind: "steer", text: "go" })).status).toBe(
      409,
    );
    expect(await (await f.send("GET", `/api/agent/sessions/${SESSION}`)).json()).toMatchObject({
      status: "ended",
    });
  });
  it("bounds growing JSON before parse and never starts after a body abort", async () => {
    const f = await setup();
    let cancelled = false;
    const tooBig = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(
      (
        await f.stream(`/api/cells/${CELL}/agent`, tooBig, undefined, {
          "content-type": "application/json",
        })
      ).status,
    ).toBe(413);
    expect(cancelled).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    const stop = new AbortController();
    const pendingBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"task":'));
      },
    });
    const pending = f.stream(`/api/cells/${CELL}/agent`, pendingBody, stop.signal, {
      "content-type": "application/json",
    });
    stop.abort();
    expect((await pending).status).toBe(499);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("does not deliver a message if Stop arrives during its body, or publish a late task start", async () => {
    const f = await setup();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const waiting = deferred();
    const source = new ReadableStream<Uint8Array>(
      {
        start(c) {
          body = c;
        },
        pull() {
          waiting.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    const pending = f.stream(endpoint("messages"), source, undefined, {
      "content-type": "application/json",
    });
    await waiting.promise;
    f.session.stop();
    body.enqueue(new TextEncoder().encode(JSON.stringify({ kind: "followup", text: "late" })));
    body.close();
    expect((await pending).status).toBe(409);
    expect(f.events.filter((event) => event.type === "message.user")).toEqual([]);
    const g = await setup();
    const entered = deferred();
    const finish = deferred<AgentSession>();
    g.start.mockImplementationOnce(async () => {
      entered.resolve();
      return finish.promise;
    });
    const stop = new AbortController();
    const starting = g.send("POST", `/api/cells/${CELL}/agent`, { task: "go" }, stop.signal);
    await entered.promise;
    stop.abort();
    finish.resolve(g.session);
    expect((await starting).status).toBe(499);
    expect(g.start).toHaveBeenCalledTimes(1);
  });
  it("returns fixed catalog and unexpected dependency errors without retrying or logging their contents", async () => {
    const f = await setup();
    const refresh = vi
      .spyOn(f.deps.catalog, "refresh")
      .mockRejectedValue(new Error("credential-fixture"));
    const response = await f.send("POST", "/api/agent/catalog/refresh");
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("the catalog could not be refreshed");
    expect(refresh).toHaveBeenCalledTimes(1);
    (f.deps.keyd.secrets as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("credential-fixture"),
    );
    const failed = await f.send("GET", "/api/agent/providers");
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("agent request failed");
  });
  it("undoes a real memory change once and records its owning session", async () => {
    const f = await setup();
    const change = f.memory.apply(SESSION, "USER.md", "append", "- preference");
    expect((await f.send("POST", `/api/agent/memory/${change.changeId}/undo`)).status).toBe(200);
    expect(f.events.at(-1)).toMatchObject({
      type: "memory.change",
      data: { undoes: change.changeId },
    });
    expect((await f.send("POST", `/api/agent/memory/${change.changeId}/undo`)).status).toBe(409);
  });
});

describe("research mode routes", () => {
  it("starts a research task only when asked, and refuses an unknown mode", async () => {
    const f = await setup();
    const task = `/api/cells/${CELL}/agent`;
    expect((await f.send("POST", task, { task: "Compare", mode: "research" })).status).toBe(202);
    expect(f.start.mock.calls[0]?.[3]).toEqual({ research: true });
    expect((await f.send("POST", task, { task: "Book" })).status).toBe(202);
    expect(f.start.mock.calls[1]).toHaveLength(3);
    expect((await f.send("POST", task, { task: "Book", mode: "deep" })).status).toBe(400);
    expect(f.start).toHaveBeenCalledTimes(2);
  });
  it("lets the user wrap up or extend a research task, and tells dot at once", async () => {
    const f = await setup();
    expect((await f.send("POST", endpoint("research"), { change: "wrap_up" })).status).toBe(409);
    f.session.research = new ResearchLog({ sources: 10, minutes: 10 }, (type, data) =>
      f.session.append(type, data),
    );
    expect((await f.send("POST", endpoint("research"), { change: "stop" })).status).toBe(400);
    expect((await f.send("POST", endpoint("research"), { change: "wrap_up" })).status).toBe(204);
    expect(f.session.research.stopped).toBe("user");
    expect((await f.send("POST", endpoint("research"), { change: "more" })).status).toBe(204);
    expect(f.session.research.stopped).toBeUndefined();
    expect(f.session.research.budget).toEqual({ sources: 20, minutes: 20 });
    expect(f.events.filter((e) => e.type === "research.budget").map((e) => e.data)).toEqual([
      { sources: 10, minutes: 10, stopped: "user" },
      { sources: 20, minutes: 20 },
    ]);
    const notes = await f.session.inbox(0, 0);
    expect(notes.items.map((item) => item.text)).toEqual([
      expect.stringContaining("The user asked you to wrap up."),
      expect.stringContaining("about 20 sources and 20 minutes"),
    ]);
  });
});

describe("Claude Code (your plan) routes", () => {
  const signedIn = {
    state: "signed_in" as const,
    version: "2.1.290",
    plan: "max",
    models: [{ id: "sonnet", name: "Sonnet" }],
    checkedAt: 1,
  };
  function claude() {
    return { status: vi.fn(async () => signedIn), check: vi.fn(async () => signedIn) };
  }
  it("reports the user's Claude Code and checks it again on request", async () => {
    const claudeCode = claude();
    const f = await setup({ claudeCode });
    const status = await f.send("GET", "/api/agent/claude-code");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(signedIn);
    const checked = await f.app.request("http://fixture/api/agent/claude-code/check", {
      method: "POST",
    });
    expect(checked.status).toBe(200);
    expect(claudeCode.check).toHaveBeenCalledTimes(1);
    const reply = (await (await f.send("GET", "/api/agent/providers")).json()) as {
      subscriptions: { id: string; available: boolean }[];
    };
    expect(reply.subscriptions.find((row) => row.id === "claude-code")).toEqual({
      id: "claude-code",
      name: "Claude Code (your plan)",
      available: true,
    });
  });
  it("has no Claude Code routes where it isn't offered", async () => {
    const f = await setup();
    expect((await f.send("GET", "/api/agent/claude-code")).status).toBe(404);
  });
  it("saves Claude Code as the main model with no key lookup, and nowhere else", async () => {
    const f = await setup({ claudeCode: claude() });
    const settings = {
      main: { provider: "claude-code", model: "sonnet" },
      fast: { provider: "anthropic", model: "stored-unavailable", key: "missing-key" },
    };
    expect((await f.send("PUT", "/api/agent/settings", settings)).status).toBe(200);
    expect(f.settings.get()).toEqual(settings);
    expect(f.deps.keyd.secrets).not.toHaveBeenCalled();
    for (const bad of [
      { main: { provider: "claude-code", model: "sonnet", key: "anthropic" } },
      {
        main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
        fast: { provider: "claude-code", model: "sonnet" },
      },
    ])
      expect((await f.send("PUT", "/api/agent/settings", bad)).status).toBe(400);
    expect(f.settings.get()).toEqual(settings);
  });
});

describe("ChatGPT settings and installation integration", () => {
  it("saves a subscription with inactive paid choices intact and no paid key lookup", async () => {
    const f = await setup();
    const settings = {
      main: { provider: "chatgpt", model: "gpt-6-astra" },
      fast: { provider: "anthropic", model: "stored-unavailable", key: "missing-key" },
      local: { provider: "lmstudio", model: "stored-local" },
      codexDenyRead: ["/Volumes/Private"],
    };
    const keys = f.deps.keyd.secrets as ReturnType<typeof vi.fn>;
    keys.mockRejectedValueOnce(new Error("must not resolve inactive paid choices"));
    const response = await f.send("PUT", "/api/agent/settings", settings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(settings);
    expect(f.settings.get()).toEqual(settings);
    expect(keys).not.toHaveBeenCalled();
  });
  it("revalidates inactive keys and prices when the main selection switches back to API", async () => {
    const f = await setup();
    const inactive = { provider: "anthropic", model: "claude-sonnet-5-5", key: "missing-key" };
    expect(
      (
        await f.send("PUT", "/api/agent/settings", {
          main: { provider: "chatgpt", model: "gpt-6-astra" },
          fast: inactive,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.send("PUT", "/api/agent/settings", {
          main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
          fast: inactive,
        })
      ).status,
    ).toBe(400);
    expect(f.settings.get().main?.provider).toBe("chatgpt");
    expect(f.deps.keyd.secrets).toHaveBeenCalledTimes(1);
  });
  it.each([
    { main: { provider: "chatgpt", model: "gpt-6-astra", key: "paid" } },
    {
      main: {
        provider: "chatgpt",
        model: "gpt-6-astra",
        price: { inputUSDPerMTok: 1, outputUSDPerMTok: 2 },
      },
    },
    {
      main: { provider: "chatgpt", model: "gpt-6-astra" },
      fast: { provider: "chatgpt", model: "gpt-6-astra" },
    },
    {
      main: { provider: "chatgpt", model: "gpt-6-astra" },
      local: { provider: "chatgpt", model: "gpt-6-astra" },
    },
    { main: { provider: "chatgpt", model: "openai/gpt-6" } },
    { main: { provider: "chatgpt", model: "gpt-6-astra" }, codexDenyRead: ["relative"] },
  ])("rejects a malformed subscription selection %j before resolving keys", async (settings) => {
    const f = await setup();
    expect((await f.send("PUT", "/api/agent/settings", settings)).status).toBe(400);
    expect(f.deps.keyd.secrets).not.toHaveBeenCalled();
    expect(f.settings.get()).toEqual({});
  });
  it("lists the subscription separately from the existing API provider rows", async () => {
    const f = await setup({
      harness: () => ({ available: false, reason: "Pinned privacy acceptance is pending." }),
    });
    const reply = (await (await f.send("GET", "/api/agent/providers")).json()) as {
      subscriptions: unknown[];
      providers: { id: string }[];
    };
    expect(reply.subscriptions).toEqual([
      {
        id: "chatgpt",
        name: "ChatGPT plan",
        available: false,
        reason: "Pinned privacy acceptance is pending.",
      },
      {
        id: "claude-code",
        name: "Claude Code (your plan)",
        available: false,
        reason: "Claude Code isn't available on this computer.",
      },
    ]);
    expect(reply.providers.some((p: { id: string }) => p.id === "chatgpt")).toBe(false);
    expect(reply.providers.some((p: { id: string }) => p.id === "anthropic")).toBe(true);
  });
  async function installedFixture() {
    let install: CodexInstallState = { state: "not_installed" };
    const gate = deferred<InstalledCodex>();
    const status = { available: true, codexVersion: "0.154.0", state: "signed_out" as const };
    const account = {
      status: vi.fn(async () => status),
      login: vi.fn(async () => ({ loginId: "fixture", method: "code" as const, startedAt: 0 })),
      cancelLogin: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      refresh: vi.fn(async () => status),
    };
    const installer = {
      status: () => structuredClone(install),
      ensureInstalled: vi.fn((_signal: AbortSignal) => {
        install = { state: "downloading", receivedBytes: 0 };
        return gate.promise;
      }),
      verifiedInstallation: vi.fn(async () => undefined),
      cancel: vi.fn(() => {}),
    };
    let available = true,
      released = true,
      sandbox: ChatgptSandbox = "unchecked";
    const plan = {
      sandbox: () => sandbox,
      check: vi.fn(async () => {
        if (install.state === "ready" && sandbox !== "passed") sandbox = "checking";
        return sandbox;
      }),
      confirm: vi.fn(async (status: ChatgptStatus) => status),
    };
    const f = await setup({
      chatgpt: { account, installer, availability: () => ({ available }), setup: plan },
      harness: () =>
        available && !released
          ? {
              available: false,
              reason: "ChatGPT plan support isn't switched on in this version yet.",
            }
          : { available },
    });
    return {
      ...f,
      account,
      installer,
      plan,
      gate,
      setInstall(value: CodexInstallState) {
        install = value;
      },
      setAvailable(value: boolean) {
        available = value;
      },
      setReleased(value: boolean) {
        released = value;
      },
      setSandbox(value: ChatgptSandbox) {
        sandbox = value;
      },
    };
  }
  it("reads uninstalled status without spawn or download and refuses login with 409", async () => {
    const f = await installedFixture();
    expect(await (await f.send("GET", "/api/agent/chatgpt")).json()).toMatchObject({
      install: { state: "not_installed" },
      state: "unavailable",
    });
    expect((await f.send("POST", "/api/agent/chatgpt/login", {})).status).toBe(409);
    expect(f.account.status).not.toHaveBeenCalled();
    expect(f.account.login).not.toHaveBeenCalled();
    expect(f.installer.ensureInstalled).not.toHaveBeenCalled();
  });
  it("starts a shared install only through the explicit empty action", async () => {
    const f = await installedFixture();
    expect((await f.send("POST", "/api/agent/chatgpt/install", {})).status).toBe(400);
    expect(f.installer.ensureInstalled).not.toHaveBeenCalled();
    expect((await f.send("POST", "/api/agent/chatgpt/install")).status).toBe(202);
    expect((await f.send("POST", "/api/agent/chatgpt/install")).status).toBe(202);
    expect(f.installer.ensureInstalled).toHaveBeenCalledTimes(1);
    expect((await f.send("POST", "/api/agent/chatgpt/install/cancel")).status).toBe(204);
    expect(f.installer.cancel).toHaveBeenCalledTimes(1);
    f.gate.resolve({
      version: "0.154.0",
      platform: "darwin-arm64",
      binDir: "/fixture",
      codexBin: "/fixture/codex",
      codeModeHostBin: "/fixture/host",
    });
  });
  it("keeps installation separate from readiness and refuses unsupported installation", async () => {
    const f = await installedFixture();
    f.setInstall({ state: "ready", version: "0.154.0" });
    f.setAvailable(false);
    expect((await f.send("POST", "/api/agent/chatgpt/install")).status).toBe(503);
    expect((await f.send("POST", "/api/agent/chatgpt/login", {})).status).toBe(503);
    expect(await (await f.send("GET", "/api/agent/chatgpt")).json()).toMatchObject({
      available: false,
      state: "unavailable",
      install: { state: "ready" },
    });
    expect(f.account.status).not.toHaveBeenCalled();
    expect(f.installer.ensureInstalled).not.toHaveBeenCalled();
  });
  it("explains the plan in plain words without internal names", async () => {
    const off = await setup();
    const reply = (await (await off.send("GET", "/api/agent/providers")).json()) as {
      subscriptions: { reason?: string }[];
    };
    expect(reply.subscriptions[0]?.reason).toBe(
      "ChatGPT plan support isn't switched on in this version yet.",
    );
    const f = await installedFixture();
    expect(await (await f.send("GET", "/api/agent/chatgpt")).json()).toMatchObject({
      available: true,
      state: "unavailable",
      reason: "Install ChatGPT support first.",
    });
    const login = await f.send("POST", "/api/agent/chatgpt/login", {});
    expect(login.status).toBe(409);
    expect(await login.text()).toBe("Install ChatGPT support first.");
    f.setAvailable(false);
    const install = await f.send("POST", "/api/agent/chatgpt/install");
    expect(install.status).toBe(503);
    expect(await install.text()).toBe("ChatGPT support can't be installed on this computer.");
  });
  it("checks this Mac's sandbox after installation, before any sign-in", async () => {
    const f = await installedFixture();
    expect((await f.send("POST", "/api/agent/chatgpt/install")).status).toBe(202);
    expect(f.plan.check).not.toHaveBeenCalled();
    f.setInstall({ state: "ready", version: "0.154.0" });
    f.gate.resolve({
      version: "0.154.0",
      platform: "darwin-arm64",
      binDir: "/fixture",
      codexBin: "/fixture/codex",
      codeModeHostBin: "/fixture/host",
    });
    await vi.waitFor(() => expect(f.plan.check).toHaveBeenCalledTimes(1));
    expect(await (await f.send("GET", "/api/agent/chatgpt")).json()).toMatchObject({
      available: true,
      state: "unavailable",
      reason: SANDBOX_REASONS.checking,
      install: { state: "ready" },
      sandbox: "checking",
    });
    const login = await f.send("POST", "/api/agent/chatgpt/login", {});
    expect(login.status).toBe(409);
    expect(await login.text()).toBe(SANDBOX_REASONS.checking);
    expect((await f.send("POST", "/api/agent/chatgpt/refresh")).status).toBe(409);
    expect(f.account.status).not.toHaveBeenCalled();
    expect(f.account.login).not.toHaveBeenCalled();
    f.setSandbox("passed");
    expect(await (await f.send("GET", "/api/agent/chatgpt")).json()).toMatchObject({
      available: true,
      state: "signed_out",
      sandbox: "passed",
    });
    expect(f.plan.confirm).toHaveBeenCalledTimes(1);
    expect((await f.send("POST", "/api/agent/chatgpt/login", {})).status).toBe(202);
  });
  it("starts a check for an installation that has none and keeps a failed check closed", async () => {
    const f = await installedFixture();
    f.setInstall({ state: "ready", version: "0.154.0" });
    expect(await (await f.send("GET", "/api/agent/chatgpt")).json()).toMatchObject({
      state: "unavailable",
      sandbox: "checking",
    });
    expect(f.plan.check).toHaveBeenCalledTimes(1);
    f.setSandbox("failed");
    expect(await (await f.send("GET", "/api/agent/chatgpt")).json()).toMatchObject({
      available: true,
      state: "unavailable",
      reason: SANDBOX_REASONS.failed,
      sandbox: "failed",
    });
    expect(f.plan.check).toHaveBeenCalledTimes(1);
    expect((await f.send("POST", "/api/agent/chatgpt/login", {})).status).toBe(409);
    const again = await f.send("POST", "/api/agent/chatgpt/check");
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ sandbox: "checking" });
    expect(f.plan.check).toHaveBeenCalledTimes(2);
    expect(f.account.status).not.toHaveBeenCalled();
  });
  it("refuses a check before installation or with a body", async () => {
    const f = await installedFixture();
    const early = await f.send("POST", "/api/agent/chatgpt/check");
    expect(early.status).toBe(409);
    expect(await early.text()).toBe("Install ChatGPT support first.");
    f.setInstall({ state: "ready", version: "0.154.0" });
    expect((await f.send("POST", "/api/agent/chatgpt/check", {})).status).toBe(400);
    f.setAvailable(false);
    expect((await f.send("POST", "/api/agent/chatgpt/check")).status).toBe(503);
    expect(f.plan.check).not.toHaveBeenCalled();
  });
  it("runs no check without release evidence for this version", async () => {
    const f = await installedFixture();
    f.setInstall({ state: "ready", version: "0.154.0" });
    f.setReleased(false);
    const refused = await f.send("POST", "/api/agent/chatgpt/check");
    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe(
      "ChatGPT plan support isn't switched on in this version yet.",
    );
    expect(f.plan.check).not.toHaveBeenCalled();
  });
  it.each(["/install", "/install/cancel", "/check"])(
    "requires the install token for %s",
    async (path) => {
      const f = await installedFixture(),
        log = new EventLog(f.home);
      const app = createApp({ token: "i".repeat(43), port: 4750, eventLog: log, agent: f.deps });
      try {
        expect(
          (await app.request(`http://127.0.0.1:4750/api/agent/chatgpt${path}`, { method: "POST" }))
            .status,
        ).toBe(401);
        expect(f.installer.ensureInstalled).not.toHaveBeenCalled();
        expect(f.installer.cancel).not.toHaveBeenCalled();
        expect(f.plan.check).not.toHaveBeenCalled();
      } finally {
        log.close();
      }
    },
  );
});

describe("bounded user file transfers", () => {
  it("refuses a duplicate through actual desktop publication without overwriting or losing the 409", async () => {
    const f = await setup(),
      desktop = new Hono();
    addToolRoutes(desktop, {
      home: f.home,
      env: {},
      browser: {
        read: async () => {
          throw new Error("Unexpected fixture browser read");
        },
        navigate: async () => {
          throw new Error("Unexpected fixture browser navigation");
        },
      },
    });
    const tools = new DesktopdTools(
      { baseUrl: "http://owned-desktopd", token: "fixture" },
      async (url, init) => desktop.fetch(new Request(url, init)),
    );
    f.deps.desktop = (_id, requestSignal) => {
      const signal = AbortSignal.any([requestSignal, f.lifetime.signal, f.session.abort.signal]);
      return { tools, signal, check: () => signal.throwIfAborted(), release: f.release };
    };
    try {
      const path = `/api/cells/${CELL}/upload?name=report.txt`;
      const first = await f.app.request(path, { method: "POST", body: "original" });
      expect(first.status).toBe(201);
      expect(await first.json()).toEqual({ path: "~/Downloads/report.txt" });
      const second = await f.app.request(path, { method: "POST", body: "replacement" });
      expect(second.status).toBe(409);
      expect(readFileSync(join(f.home, "Downloads", "report.txt"), "utf8")).toBe("original");
      expect(f.release).toHaveBeenCalledTimes(2);
    } finally {
      await tools.close();
    }
  });
  it("refuses hidden and encoded traversal upload names before desktop admission", async () => {
    const f = await setup();
    for (const name of [".hidden", "..", "a/b", "a\\b", "nul\0name"]) {
      const response = await f.app.request(
        `/api/cells/${CELL}/upload?name=${encodeURIComponent(name)}`,
        { method: "POST", body: "x" },
      );
      expect(response.status).toBe(400);
    }
    expect(f.put).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it("streams an upload through the admitted lifetime and releases it after settlement", async () => {
    const f = await setup();
    const response = await f.app.request(`/api/cells/${CELL}/upload?name=report.pdf`, {
      method: "POST",
      body: "pdf",
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ path: "~/Downloads/report.pdf" });
    expect(f.transferred).toBe(3);
    expect(f.put.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);
    expect(f.put.mock.calls[0]?.[4]).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "1"])(
    "rejects actual upload overflow with declared length %s without buffering it",
    async (declared) => {
      const f = await setup();
      let cancelled = false;
      let produced = 0;
      const chunk = new Uint8Array(1024 * 1024);
      const source = new ReadableStream<Uint8Array>({
        pull(c) {
          if (produced++ < 102) c.enqueue(chunk);
          else c.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = await f.stream(
        `/api/cells/${CELL}/upload?name=big.bin`,
        source,
        undefined,
        declared ? { "content-length": declared } : {},
      );
      expect(response.status).toBe(413);
      expect(f.transferred).toBe(TRANSFER_BYTES);
      expect(cancelled).toBe(true);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.put).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses declared oversize before admission and lifetime loss cannot publish upload success", async () => {
    const f = await setup();
    expect(
      (
        await f.app.request(`/api/cells/${CELL}/upload?name=x`, {
          method: "POST",
          body: "x",
          headers: { "content-length": String(TRANSFER_BYTES + 1) },
        })
      ).status,
    ).toBe(413);
    expect(f.deps.desktop).not.toHaveBeenCalled();
    const entered = deferred();
    const finish = deferred<string>();
    f.put.mockImplementationOnce(async () => {
      entered.resolve();
      return finish.promise;
    });
    const pending = f.app.request(`/api/cells/${CELL}/upload?name=x`, {
      method: "POST",
      body: "x",
    });
    await entered.promise;
    f.lifetime.abort();
    expect(f.release).not.toHaveBeenCalled();
    finish.resolve("~/Downloads/x");
    expect((await pending).status).toBe(499);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("refuses upload during takeover and cancels a pending upload read when its lifetime ends", async () => {
    const f = await setup();
    const taking = f.session.takeover("login", "note");
    await Promise.resolve();
    await Promise.resolve();
    const response = await f.app.request(`/api/cells/${CELL}/upload?name=x`, {
      method: "POST",
      body: "x",
    });
    expect(response.status).toBe(409);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    f.session.endTakeover(f.session.pendingTakeover as string, undefined);
    await taking;
    const reading = deferred();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const pending = f.stream(`/api/cells/${CELL}/upload?name=x`, source);
    await reading.promise;
    f.lifetime.abort();
    expect((await pending).status).toBe(499);
    expect(cancelled).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.put).toHaveBeenCalledTimes(1);
  });
  it("does not retry an uncertain desktop upload or reflect its error", async () => {
    const f = await setup();
    f.put.mockRejectedValueOnce(new Error("credential-fixture"));
    const response = await f.app.request(`/api/cells/${CELL}/upload?name=x`, {
      method: "POST",
      body: "x",
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("agent request failed");
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("serves regular outputs as attachment-only streams and refuses final or ancestor links", async () => {
    const f = await setup();
    const out = join(f.home, "sessions", SESSION, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "report.html"), "<script>not rendered</script>");
    const response = await f.send("GET", endpoint("files/report.html"));
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("<script>not rendered</script>");
    const outside = join(f.home, "secret");
    writeFileSync(outside, "not downloadable");
    symlinkSync(outside, join(out, "linked"));
    expect((await f.send("GET", endpoint("files/linked"))).status).toBe(404);
    renameSync(out, `${out}-saved`);
    symlinkSync(`${out}-saved`, out);
    expect((await f.send("GET", endpoint("files/report.html"))).status).toBe(404);
  });
  it("stops serving a download when the request is cancelled", async () => {
    const f = await setup();
    const out = join(f.home, "sessions", SESSION, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "large.bin"), new Uint8Array(1024 * 1024));
    const stop = new AbortController();
    const response = await f.send("GET", endpoint("files/large.bin"), undefined, stop.signal);
    stop.abort();
    await expect(response.arrayBuffer()).rejects.toThrow("download cancelled");
  });
  it("holds the opened descriptor across path replacement and aborts output growth beyond its bound", async () => {
    const f = await setup();
    const out = join(f.home, "sessions", SESSION, "out");
    mkdirSync(out, { recursive: true });
    const file = join(out, "report.bin");
    writeFileSync(file, "original");
    const response = await f.send("GET", endpoint("files/report.bin"));
    renameSync(file, `${file}-old`);
    writeFileSync(file, "replacement");
    expect(await response.text()).toBe("original");
    writeFileSync(file, "a".repeat(64 * 1024));
    const growing = await f.send("GET", endpoint("files/report.bin"));
    truncateSync(file, TRANSFER_BYTES + 1);
    await expect(growing.arrayBuffer()).rejects.toThrow("download interrupted");
    expect((await f.send("GET", endpoint("files/report.bin"))).status).toBe(413);
  });
});

it("rejects budget mutation after a streamed body loses takeover/readiness ownership", async () => {
  for (const loss of ["takeover", "stopped", "busy"] as const) {
    const f = await setup();
    let ready = true;
    f.deps.taskMutationReady = () => ready;
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const work = f.stream(
      endpoint("budget"),
      new ReadableStream({
        start(c) {
          body = c;
        },
      }),
      undefined,
      { "content-type": "application/json" },
    );
    await Promise.resolve();
    if (loss === "takeover") {
      const taking = f.session.takeover("login", "Owned fake login");
      void taking.catch(() => {});
      await Promise.resolve();
    } else if (loss === "stopped") f.session.stop();
    else ready = false;
    body.enqueue(new TextEncoder().encode(JSON.stringify({ budgetUSD: 8 })));
    body.close();
    expect((await work).status).toBe(409);
    expect(f.raise, "no lost-owner ceiling mutation may reach keyd").not.toHaveBeenCalled();
  }
});
it("requires an empty resume/undo body and rechecks paused ownership and memory conflict without overwriting a later change", async () => {
  const f = await setup();
  f.session.status = "paused";
  expect((await f.send("POST", endpoint("resume"), { budgetUSD: 99 })).status).toBe(400);
  expect(f.session.inboxSequence).toBe(0);
  const change = f.memory.apply(SESSION, "MEMORY.md", "append", "First remembered fact");
  const undoPath = `/api/agent/memory/${change.changeId}/undo`;
  f.deps.canChangeMemory = () => false;
  expect((await f.send("POST", undoPath)).status).toBe(503);
  expect(f.memory.readBoth().memory).toContain("First remembered fact");
  f.deps.canChangeMemory = () => true;
  expect((await f.send("POST", undoPath, { changeId: SESSION })).status).toBe(400);
  f.memory.apply(SESSION, "MEMORY.md", "append", "Later remembered fact");
  expect((await f.send("POST", undoPath)).status).toBe(409);
  expect(f.memory.readBoth().memory).toContain("Later remembered fact");
  const current = f.memory.apply(SESSION, "USER.md", "append", "A current fact");
  expect((await f.send("POST", `/api/agent/memory/${current.changeId}/undo`)).status).toBe(200);
  expect(f.events.at(-1)).toMatchObject({
    type: "memory.change",
    data: { undoes: current.changeId },
  });
  expect((await f.send("POST", endpoint("resume"))).status).toBe(204);
  expect(f.session.inboxSequence).toBe(1);
});

it("safety Pause and Resume require the exact DTO owner and refuse a missing control adapter", async () => {
  const f = await setup(),
    requestId = ulid();
  const pausePath = `/api/agent/sessions/${SESSION}/pause`,
    resumePath = `/api/agent/sessions/${SESSION}/resume`;
  expect((await f.send("POST", pausePath, { requestId })).status).toBe(503);
  const pause = vi.fn((_sessionId: string, id: string) => {
    const state = f.session.requestSafetyPause(id);
    f.session.confirmSafetyPause(id, state.revision);
    return f.session.safetyPause;
  });
  const resume = vi.fn(async (_sessionId: string, id: string, revision: number) => {
    try {
      f.session.resumeSafety(id, revision);
    } catch {
      throw new AgentError(409, "stale Pause owner");
    }
  });
  f.deps.runner.pauseTask = pause as NonNullable<AgentRoutesDeps["runner"]["pauseTask"]>;
  f.deps.runner.resumeSafety = resume;
  for (const body of [{ requestId, extra: true }, { requestId: "bad" }, {}])
    expect((await f.send("POST", pausePath, body)).status).toBe(400);
  expect(pause).not.toHaveBeenCalled();
  const response = await f.send("POST", pausePath, { requestId });
  expect(response.status).toBe(202);
  const state = (await response.json()) as { revision: number };
  expect(f.session.safetyPause?.requestId).toBe(requestId);
  expect((await f.send("POST", resumePath)).status).toBe(400);
  expect(
    (await f.send("POST", resumePath, { requestId, revision: state.revision, approve: true }))
      .status,
  ).toBe(400);
  expect(resume).not.toHaveBeenCalled();
  expect(
    (await f.send("POST", resumePath, { requestId, revision: state.revision + 1 })).status,
  ).toBe(409);
  expect(f.session.safetyPause?.phase).toBe("paused");
  expect((await f.send("POST", resumePath, { requestId, revision: state.revision })).status).toBe(
    204,
  );
  expect(f.session.safetyPause).toBeUndefined();
});

it("queues user follow-ups and promotes the original message without duplication", async () => {
  const f = await setup();
  expect(
    (
      await f.send("POST", `/api/agent/sessions/${SESSION}/messages`, {
        kind: "followup",
        text: "Later task",
      })
    ).status,
  ).toBe(202);
  expect((await f.session.inbox(0, 0)).items).toEqual([]);
  const message = f.events.find((event) => event.type === "message.user")?.data as {
    messageId: string;
    queued: boolean;
  };
  expect(message.queued).toBe(true);
  const path = `/api/agent/sessions/${SESSION}/messages/${message.messageId}/steer`;
  expect((await f.send("POST", path)).status).toBe(204);
  expect((await f.send("POST", path)).status).toBe(204);
  expect((await f.session.inbox(0, 0)).items).toHaveLength(1);
  expect(f.events.filter((event) => event.type === "message.user")).toHaveLength(1);
});
it("acknowledges normal task Stop only after the runner has released it", async () => {
  const f = await setup();
  const release = deferred<boolean>();
  f.deps.runner.stopRun = vi.fn(() => release.promise);
  let done = false;
  const request = Promise.resolve(f.send("POST", `/api/agent/sessions/${SESSION}/stop`)).then(
    (response) => {
      done = true;
      return response;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(done).toBe(false);
  release.resolve(true);
  expect((await request).status).toBe(204);
  expect(f.deps.runner.stopRun).toHaveBeenCalledWith(SESSION);
});

it("withdraws queued messages atomically for editing, with an idempotent receipt", async () => {
  const f = await setup();
  await f.send("POST", `/api/agent/sessions/${SESSION}/messages`, {
    kind: "followup",
    text: "Edit this later",
  });
  const message = f.events.find((e) => e.type === "message.user")?.data as { messageId: string };
  const path = `/api/agent/sessions/${SESSION}/messages/${message.messageId}`;
  for (let i = 0; i < 2; i++) {
    const reply = await f.send("POST", `${path}/edit`);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ text: "Edit this later" });
  }
  expect((await f.send("POST", `${path}/steer`)).status).toBe(404);
  expect((await f.session.inbox(0, 0)).items).toEqual([]);
  expect(f.events.filter((e) => e.type === "message.delivery")).toHaveLength(1);
});
it("does not withdraw a queued message that already reached the model", async () => {
  const f = await setup();
  await f.send("POST", `/api/agent/sessions/${SESSION}/messages`, {
    kind: "followup",
    text: "Already sent",
  });
  const message = f.events.find((e) => e.type === "message.user")?.data as { messageId: string };
  const path = `/api/agent/sessions/${SESSION}/messages/${message.messageId}`;
  expect((await f.send("POST", `${path}/steer`)).status).toBe(204);
  expect((await f.send("POST", `${path}/edit`)).status).toBe(409);
  expect((await f.session.inbox(0, 0)).items).toHaveLength(1);
});

it("cancels queued messages once, without drafting or delivering them", async () => {
  const f = await setup();
  await f.send("POST", `/api/agent/sessions/${SESSION}/messages`, {
    kind: "followup",
    text: "Cancel me",
  });
  const message = f.events.find((e) => e.type === "message.user")?.data as { messageId: string };
  const path = `/api/agent/sessions/${SESSION}/messages/${message.messageId}`;
  expect((await f.send("POST", `${path}/cancel`)).status).toBe(204);
  expect((await f.send("POST", `${path}/cancel`)).status).toBe(204);
  expect((await f.send("POST", `${path}/edit`)).status).toBe(409);
  expect((await f.send("POST", `${path}/steer`)).status).toBe(404);
  expect((await f.session.inbox(0, 0)).items).toEqual([]);
  expect(f.events.filter((e) => e.type === "message.delivery").map((e) => e.data)).toEqual([
    { messageId: message.messageId, state: "cancelled" },
  ]);
});
it("cannot cancel a message after steering has delivered it", async () => {
  const f = await setup();
  await f.send("POST", `/api/agent/sessions/${SESSION}/messages`, {
    kind: "followup",
    text: "Keep me",
  });
  const message = f.events.find((e) => e.type === "message.user")?.data as { messageId: string };
  const path = `/api/agent/sessions/${SESSION}/messages/${message.messageId}`;
  expect((await f.send("POST", `${path}/steer`)).status).toBe(204);
  expect((await f.send("POST", `${path}/cancel`)).status).toBe(409);
  expect((await f.session.inbox(0, 0)).items).toHaveLength(1);
});

describe("private saved-key answer verification", () => {
  const binding = {
    id: "catalog",
    kind: "http" as const,
    hosts: ["api.example.test"],
    header: "X-API-Key",
    format: "raw" as const,
  };
  const record = { ...binding, createdAt: at, updatedAt: at };
  it.each(["missing", "wrong destination", "revoked", "raw value"])(
    "rejects %s instead of unblocking the task",
    async (kind) => {
      const f = await setup();
      const asking = f.session.askFields(
        {
          question: "Catalog access",
          fields: [
            {
              id: "key",
              kind: "api_key",
              label: "API key",
              credential: { binding, metadata: { label: "Catalog" } },
            },
          ],
        },
        0,
      );
      vi.mocked(f.deps.keyd.secrets).mockResolvedValue(
        kind === "missing"
          ? []
          : kind === "wrong destination"
            ? [{ ...record, hosts: ["other.example.test"] }]
            : kind === "revoked"
              ? [{ ...record, reenter: true }]
              : [record],
      );
      const askId = f.session.pendingAsk;
      expect(
        (
          await f.send("POST", endpoint("answer"), {
            askId,
            fields: { key: kind === "raw value" ? "private-value" : true },
          })
        ).status,
      ).toBe(409);
      expect(f.session.pendingAsk).toBe(askId);
      expect(JSON.stringify(f.events)).not.toContain("private-value");
      f.session.stop();
      await asking;
    },
  );
  it("verifies the saved binding and records only provided=true", async () => {
    const f = await setup();
    const asking = f.session.askFields(
      {
        question: "Catalog access",
        fields: [
          {
            id: "key",
            kind: "api_key",
            label: "API key",
            credential: { binding, metadata: { label: "Catalog" } },
          },
        ],
      },
      0,
    );
    vi.mocked(f.deps.keyd.secrets).mockResolvedValue([record]);
    expect(
      (
        await f.send("POST", endpoint("answer"), {
          askId: f.session.pendingAsk,
          fields: { key: true },
        })
      ).status,
    ).toBe(204);
    expect(await asking).toMatchObject({ by: "user", fields: { key: { provided: true } } });
    expect(f.session.pendingAsk).toBeUndefined();
  });
});
