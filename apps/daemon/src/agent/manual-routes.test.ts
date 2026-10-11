import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { DesktopdClient } from "../desktopd/client.ts";
import { FakeDesktopd } from "../desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../event-log.ts";
import { type AgentRoutesDeps, agentRoutes } from "./routes.ts";
import { AgentSession } from "./session.ts";
import { TranscriptStore } from "./transcript.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.restoreAllMocks();
});
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-manual-routes-")),
    log = new EventLog(home),
    cell = ulid(),
    id = log.createSession("Synthetic manual control");
  const session = new AgentSession(id, cell, "Synthetic task", log);
  session.beginBrain();
  const outcome = session.takeover("login", "Sample login").catch(() => ({ by: "stop" as const }));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const requestId = session.pendingTakeover;
  if (!requestId) throw new Error("missing takeover fixture");
  const fake = new FakeDesktopd(),
    client = new DesktopdClient(
      { baseUrl: "http://owned-desktop.invalid", token: fake.token },
      fake.fetchImpl,
    );
  const factory = vi.fn(() => ({
    screen: { w: 1280, h: 800 },
    client,
    prepare: async () => {},
    check: () => {},
    release: () => {},
  }));
  const unused = () => {
    throw new Error("unexpected dependency access");
  };
  const deps: AgentRoutesDeps = {
    runner: {
      start: unused,
      get: (key) => (key === id ? session : undefined),
      raiseBudget: unused,
    },
    settings: { get: unused, put: unused },
    catalog: {
      fresh() {
        return Promise.resolve(this.get());
      },
      freshness: () => ({ stale: false, refreshing: false, refreshFailed: false }),
      get: unused,
      refresh: unused,
    },
    keyd: { secrets: unused },
    memory: {
      readBoth: unused,
      undo: unused,
      entries: unused,
      notes: unused,
      addEntry: unused,
      editEntry: unused,
      deleteEntry: unused,
    },
    skills: () => [],
    desktop: unused,
    manual: factory,
    redactUserText: (text) => text,
    appendTo: unused,
    home,
  };
  const app = createApp({ token: "inert-token", port: 4747, eventLog: log });
  agentRoutes(app, deps);
  const send = (body: unknown, over: RequestInit = {}, path = "takeover/input") =>
    app.request(`http://127.0.0.1:4747/api/agent/sessions/${id}/${path}`, {
      method: "POST",
      ...over,
      headers: {
        authorization: "Bearer inert-token",
        "content-type": "application/json",
        ...over.headers,
      },
      body: JSON.stringify(body),
    });
  cleanup.push(async () => {
    session.stop();
    await outcome;
    await session.toolsSettled();
    log.close();
    rmSync(home, { force: true, recursive: true });
  });
  return { app, home, log, session, id, requestId, fake, factory, send, deps };
}
it("mounts manual text under actual app auth and sends Unicode/password text masked without journal, inbox or transcript leakage", async () => {
  const f = await setup(),
    sentinel = "synthetic-password 中文🙂";
  const body = { requestId: f.requestId, input: { kind: "text", text: sentinel } };
  for (const [headers, status] of [
    [{ authorization: "" }, 401],
    [{ origin: "https://foreign.invalid" }, 403],
    [{ host: "foreign.invalid" }, 403],
  ] as const) {
    expect((await f.send(body, { headers })).status).toBe(status);
    expect(f.factory).not.toHaveBeenCalled();
  }
  f.fake.script.type = () => ({
    progress: [{ count: 1, pressMono: 1, chunk: sentinel }],
    result: {
      done: true,
      count: [...sentinel].length,
      firstPressMono: 1,
      armedMono: 0,
      injector: "xtest",
    },
  });
  expect((await f.send(body)).status).toBe(204);
  expect(f.fake.calls).toHaveLength(1);
  expect(f.fake.calls[0]).toMatchObject({
    path: "/type",
    body: { text: sentinel, masked: true, pace: { firstMs: 0, firstCount: 0, restMs: 0 } },
  });
  const events = readFileSync(join(f.home, "sessions", f.id, "events.jsonl"), "utf8");
  expect(events).toContain("takeover.request");
  expect(events).not.toContain(sentinel);
  expect(f.session.inboxSequence).toBe(0);
  expect(new TranscriptStore(f.home).state(f.id).messages).toEqual([]);
});
it("refuses extra authority, held shapes, oversized bodies and stale request IDs before any native call", async () => {
  const f = await setup(),
    input = { kind: "key", combo: ["tab"] };
  for (const body of [
    { requestId: f.requestId, input, cellId: ulid() },
    { requestId: f.requestId, input: { kind: "down", key: "tab" } },
    { requestId: f.requestId, input: { kind: "text", text: "x".repeat(4001) } },
    { requestId: f.requestId, input: { kind: "text", text: "\ud800" } },
  ])
    expect((await f.send(body)).status).toBe(400);
  expect(
    (await f.send({ requestId: f.requestId, input: { kind: "text", text: "x".repeat(65536) } }))
      .status,
  ).toBe(413);
  expect((await f.send({ requestId: ulid(), input })).status).toBe(409);
  expect(f.fake.calls).toEqual([]);
  expect(f.factory).not.toHaveBeenCalled();
  const snapshot = await f.app.request(`http://127.0.0.1:4747/api/agent/sessions/${f.id}`, {
    headers: { authorization: "Bearer inert-token" },
  });
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toMatchObject({
    pendingTakeover: f.requestId,
    manualControl: "ready",
  });
});
it("keeps partial or interrupted typing unconfirmed and refuses hand-back until Stop", async () => {
  const f = await setup();
  f.fake.script.type = () => ({
    progress: [],
    result: { done: true, count: 1, firstPressMono: 1, armedMono: 0, injector: "xtest" },
  });
  const response = await f.send({
    requestId: f.requestId,
    input: { kind: "text", text: "partial 中文" },
  });
  expect(response.status).toBe(499);
  expect(await response.text()).toBe("manual input completion could not be confirmed; use Stop");
  expect(f.session.manualControl).toBe("unconfirmed");
  expect((await f.send({ requestId: f.requestId }, {}, "takeover/done")).status).toBe(409);
  expect(f.session.controlHeld).toBe(true);
  expect(f.log.read(f.id).some((event) => event.type === "takeover.end")).toBe(false);
});
it("cancels an actual desktop typing stream on caller abort and keeps the daemon hold", async () => {
  const f = await setup(),
    owner = new AbortController(),
    entered = Promise.withResolvers<void>();
  f.fake.script.typeHolds = true;
  f.fake.script.type = () => {
    entered.resolve();
    return {
      progress: [{ count: 1, chunk: "synthetic-secret", pressMono: 1 }],
      result: { done: true, count: 1, firstPressMono: 1, armedMono: 0, injector: "xtest" },
    };
  };
  const work = f.send(
    { requestId: f.requestId, input: { kind: "text", text: "synthetic-secret 中文" } },
    { signal: owner.signal },
  );
  await entered.promise;
  owner.abort();
  expect((await work).status).toBe(499);
  expect(f.session.manualControl).toBe("unconfirmed");
  expect(JSON.stringify(f.log.read(f.id))).not.toContain("synthetic-secret");
  expect(f.session.controlHeld).toBe(true);
});
