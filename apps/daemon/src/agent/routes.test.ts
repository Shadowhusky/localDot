import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeydRecord } from "@localdot/protocol";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeydUnavailableError } from "../keyd/client.ts";
import { CatalogStore } from "./catalog-store.ts";
import { TRANSFER_BYTES } from "./download.ts";
import { MemoryStore } from "./memory.ts";
import { type AgentRoutesDeps, agentRoutes } from "./routes.ts";
import { AgentError } from "./runner.ts";
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
async function setup() {
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
  const start = vi.fn(async (_cell: string, _task: string, _signal?: AbortSignal) => session);
  const raise = vi.fn(async (_id: string, _budget: number) => {});
  const redact = vi.fn((text: string) => text.replaceAll("credential-fixture", "[redacted]"));
  const deps: AgentRoutesDeps = {
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
  it("keeps takeover held across messages/resume/stale handback and accepts only the matching user handback", async () => {
    const f = await setup();
    const taking = f.session.takeover("login", "note");
    await Promise.resolve();
    await Promise.resolve();
    const requestId = f.session.pendingTakeover;
    expect(
      (await f.send("POST", endpoint("messages"), { kind: "followup", text: "next" })).status,
    ).toBe(202);
    // A stale paused status cannot authorize Resume while the daemon owns the handover.
    f.session.status = "paused";
    expect((await f.send("POST", endpoint("resume"))).status).toBe(409);
    expect((await f.send("POST", endpoint("takeover/done"), { requestId: SESSION })).status).toBe(
      409,
    );
    expect(f.session.controlHeld).toBe(true);
    expect((await f.send("POST", endpoint("takeover/done"), { requestId })).status).toBe(204);
    expect(await taking).toEqual({ by: "user" });
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

describe("bounded user file transfers", () => {
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
