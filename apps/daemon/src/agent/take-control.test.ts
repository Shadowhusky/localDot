import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { actPolicy } from "./policy.ts";
import { redactor } from "./redact.ts";
import { type AgentRoutesDeps, agentRoutes } from "./routes.ts";
import { PausedStepError } from "./safety/step-barrier.ts";
import { AgentSession, ControlHeldError } from "./session.ts";
import { PROXY_TOKEN, toolHarness } from "./testing/harness.ts";
import { type DispatchDeps, dispatchTool } from "./tools/index.ts";

const fixtures: (() => void)[] = [];
afterEach(() => {
  for (const close of fixtures.splice(0)) close();
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing value");
  return value;
}
function setup() {
  const h = toolHarness();
  fixtures.push(h.close);
  const deps: DispatchDeps = { tools: h.tools, policy: actPolicy };
  const redact = redactor([PROXY_TOKEN]);
  const call = (name: string, input: unknown, generation = h.session.generation) =>
    dispatchTool(deps, h.session, name, ulid(), input, redact, generation);
  return { ...h, deps, call };
}
const turns = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("fixture did not reach its boundary");
};
const CLICK = { action: "click", point: { x: 300, y: 200 } };

describe("the user takes the computer while dot works", () => {
  it("lets the user in only once dot's call on its way has settled, and none reaches the computer", async () => {
    const h = setup();
    const old = required(h.session.generation);
    const verdict = Promise.withResolvers<{ kind: "act" }>();
    h.deps.policy = { decide: () => verdict.promise };
    const waiting = h.call("computer", CLICK, old);
    await turns();
    const requestId = h.session.takeControl();
    expect(h.session.controlHeld).toBe(true);
    expect(h.session.isCurrent(old)).toBe(false);
    await turns();
    expect(h.session.manualControl).toBe("waiting");
    expect(h.events().some((event) => event.type === "takeover.request")).toBe(false);
    verdict.resolve({ kind: "act" });
    expect((await waiting).result.ok).toBe(false);
    await until(() => h.session.manualControl === "ready");
    expect(h.events().find((event) => event.type === "takeover.request")?.data).toEqual({
      requestId,
      reason: "other",
      note: "",
      by: "user",
    });
    expect(h.session.takeControl()).toBe(requestId);
    h.deps.policy = actPolicy;
    for (const input of [CLICK, { action: "type", text: "x" }, { action: "screenshot" }])
      expect((await h.call("computer", input, old)).result.ok).toBe(false);
    expect(() => h.session.beginBrain()).toThrow(ControlHeldError);
    expect(h.actions).toEqual([]);
  });

  it("cancels an input already dispatching before the user gets the computer", async () => {
    const h = setup();
    const dispatching = Promise.withResolvers<void>();
    h.tools.gateway.run = (ctx) => {
      dispatching.resolve();
      return new Promise((_resolve, reject) =>
        ctx.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      );
    };
    const clicking = h.call("computer", CLICK);
    await dispatching.promise;
    h.session.takeControl();
    expect((await clicking).result.ok).toBe(false);
    await until(() => h.session.manualControl === "ready");
    expect(h.session.status).toBe("waiting_user");
  });

  it("hands back with a note and a fresh look for dot, never what the user did there", async () => {
    const h = setup();
    const requestId = h.session.takeControl();
    await until(() => h.session.manualControl === "ready");
    const lease = h.session.admitManual(requestId, new AbortController().signal);
    lease.typed();
    lease.finish();
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    expect(h.session.status).toBe("running");
    expect(h.events().find((event) => event.type === "takeover.end")?.data).toEqual({
      requestId,
      by: "user",
      typed: true,
    });
    expect(h.events().some((event) => event.type === "message.user")).toBe(false);
    // The task carries on with a new brain, which hears what happened first.
    const generation = h.session.beginBrain();
    const inbox = await h.session.inbox(0, 0, undefined, generation);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]?.kind).toBe("steer");
    expect(inbox.items[0]?.text).toMatch(/took over the computer .* handed it back/);
    const first = await h.call("computer", CLICK, generation);
    expect(first.result).toMatchObject({ ok: false, cancelled: "stale" });
    expect(first.result.content.some((part) => part.type === "image")).toBe(true);
    expect(h.actions).toEqual([]);
    expect((await h.call("computer", CLICK, generation)).result.ok).toBe(true);
    expect(h.actions).toHaveLength(1);
    // Looking again did nothing on the computer, so nothing failed.
    const ends = h.events().filter((event) => event.type === "step.end");
    expect(ends.map((event) => event.data.status)).toEqual(["cancelled", "ok"]);
  });

  it("forgets the frame and page from before the user had the computer, so dot looks afresh", async () => {
    const h = setup();
    h.session.lastFrameId = ulid();
    h.session.pageRefs = {
      cellId: h.session.cellId,
      url: "https://example.com/",
      elements: new Map(),
    };
    const requestId = h.session.takeControl();
    await until(() => h.session.manualControl === "ready");
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    expect(h.session.lastFrameId).toBeUndefined();
    expect(h.session.pageRefs).toBeUndefined();
  });

  it("owes a look until a screenshot succeeds, and a wait's screenshot pays it", async () => {
    const h = setup();
    const requestId = h.session.takeControl();
    await until(() => h.session.manualControl === "ready");
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    const generation = h.session.beginBrain();
    const observe = h.tools.gateway.observe;
    h.tools.gateway.observe = async () => {
      throw new Error("capture failed");
    };
    expect((await h.call("computer", CLICK, generation)).result.ok).toBe(false);
    h.tools.gateway.observe = observe;
    expect(h.session.lookOwed).toBe(true);
    expect((await h.call("computer", { action: "wait", duration: 0 }, generation)).result.ok).toBe(
      true,
    );
    expect(h.session.lookOwed).toBe(false);
    expect((await h.call("computer", CLICK, generation)).result.ok).toBe(true);
  });

  it("stops a batch at its first step to look again after the user had the computer", async () => {
    const h = setup();
    const requestId = h.session.takeControl();
    await until(() => h.session.manualControl === "ready");
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    const generation = h.session.beginBrain();
    const batch = { action: "batch", steps: [CLICK, { action: "type", text: "x" }] };
    const first = await h.call("computer", batch, generation);
    expect(first.result).toMatchObject({ ok: false, cancelled: "stale" });
    expect(first.result.content.some((part) => part.type === "image")).toBe(true);
    expect(h.actions).toEqual([]);
    expect(h.session.lookOwed).toBe(false);
    expect((await h.call("computer", batch, generation)).result.ok).toBe(true);
    expect(h.actions).toHaveLength(2);
  });

  it("sets dot's question aside when the user takes the computer, and dot hears to ask again", async () => {
    const h = setup();
    const asking = h.call("ask_user", { question: "Which file?", options: ["A", "B"] });
    await until(() => !!h.session.pendingAsk);
    const requestId = h.session.takeControl();
    await asking;
    expect(h.events().find((event) => event.type === "ask.answer")?.data).toMatchObject({
      by: "control",
    });
    await until(() => h.session.manualControl === "ready");
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    const generation = h.session.beginBrain();
    const inbox = await h.session.inbox(0, 0, undefined, generation);
    expect(inbox.items[0]?.text).toMatch(/ask it again/);
  });

  it("takes the computer from a task at rest and leaves it at rest, its note waiting for the user", async () => {
    const h = setup();
    h.session.retireBrain(required(h.session.generation));
    h.session.setStatus("idle");
    const requestId = h.session.takeControl();
    await until(() => h.session.manualControl === "ready");
    expect(h.session.status).toBe("idle");
    expect(h.events().some((event) => event.type === "agent.state")).toBe(false);
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    expect(h.session.status).toBe("idle");
    expect(await h.session.waitForUser(20)).toBe(false);
    h.session.post("followup", "Now save it");
    expect(await h.session.waitForUser(20)).toBe(true);
  });

  it("takes the computer from a held Pause and keeps the Pause, which Continue ends after hand-back", async () => {
    const h = setup();
    const generation = required(h.session.generation);
    const pauseId = ulid();
    h.session.confirmSafetyPause(pauseId, h.session.requestSafetyPause(pauseId).revision);
    const requestId = h.session.takeControl();
    await until(() => h.session.manualControl === "ready");
    expect(h.session.isCurrent(generation)).toBe(true);
    expect(h.session.safetyPause).toMatchObject({ phase: "paused", resumeAvailable: false });
    // Viewers read Continue's availability from the journal, so each change is published.
    const published = () =>
      h
        .events()
        .filter((event) => event.type === "safety.pause")
        .map((event) => (event.data.pause as { resumeAvailable: boolean }).resumeAvailable);
    expect(published().slice(-2)).toEqual([true, false]);
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    expect(h.session.safetyPause).toMatchObject({ phase: "paused", resumeAvailable: true });
    expect(published().at(-1)).toBe(true);
    expect(h.session.status).toBe("paused");
  });

  it("journals the user taking the computer dot handed over, once, and keeps dot's hand-off", async () => {
    const h = setup();
    const asked = h.call("request_takeover", { reason: "login", note: "Sign in" });
    await until(() => h.session.manualControl === "ready");
    const requestId = required(h.session.pendingTakeover);
    expect(h.session.takeControl()).toBe(requestId);
    expect(h.session.takeControl()).toBe(requestId);
    const changes = h.events().filter((event) => event.type === "control.change");
    expect(changes.map((event) => event.data)).toEqual([
      { holder: "user", reason: "handoff_request" },
    ]);
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    expect((await asked).result.ok).toBe(true);
    // dot's own hand-off hears from its tool, not from a note in the inbox.
    expect(h.session.inboxSequence).toBe(0);
  });

  it("journals the user taking dot's hand-over while it is still on its way, once it is held", async () => {
    const h = setup();
    const verdict = Promise.withResolvers<{ kind: "act" }>();
    h.deps.policy = { decide: () => verdict.promise };
    const clicking = h.call("computer", CLICK);
    await turns();
    h.deps.policy = actPolicy;
    const asked = h.call("request_takeover", { reason: "login", note: "Sign in" });
    await turns();
    expect(h.session.manualControl).toBe("waiting");
    const requestId = h.session.takeControl();
    verdict.resolve({ kind: "act" });
    await clicking;
    await until(() => h.session.manualControl === "ready");
    expect(h.session.pendingTakeover).toBe(requestId);
    const types = h
      .events()
      .filter((event) => event.type === "takeover.request" || event.type === "control.change")
      .map((event) => event.type);
    expect(types).toEqual(["takeover.request", "control.change"]);
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    expect((await asked).result.ok).toBe(true);
  });

  it("marks a step the user chose to do themselves as theirs from the start", async () => {
    const h = setup();
    void h.session
      .takeover("other", "Do this yourself", undefined, undefined, true)
      .catch(() => {});
    await until(() => h.session.manualControl === "ready");
    expect(h.events().find((event) => event.type === "takeover.request")?.data).toMatchObject({
      by: "user",
    });
    h.session.takeControl();
    expect(h.events().some((event) => event.type === "control.change")).toBe(false);
  });

  it("keeps dot off the computer while the user holds the one it handed over", async () => {
    const h = setup();
    const asked = h.call("request_takeover", { reason: "login", note: "Sign in" });
    await until(() => h.session.manualControl === "ready");
    const requestId = h.session.takeControl();
    for (const input of [CLICK, { action: "type", text: "x" }, { action: "screenshot" }])
      expect((await h.call("computer", input)).result.ok).toBe(false);
    expect(h.actions).toEqual([]);
    const lease = h.session.admitManual(requestId, new AbortController().signal);
    lease.typed();
    lease.finish();
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    const { result } = await asked;
    expect(result.ok).toBe(true);
    expect(result.content.some((part) => part.type === "image")).toBe(true);
    expect(h.events().find((event) => event.type === "takeover.end")?.data).toEqual({
      requestId,
      by: "user",
      typed: true,
    });
  });

  it("hands dot's hand-off back on Not now, telling dot to find another way, with a fresh look", async () => {
    const h = setup();
    const asked = h.call("request_takeover", { reason: "login", note: "Sign in" });
    await until(() => h.session.manualControl === "ready");
    const requestId = h.session.takeControl();
    expect(await h.session.handback(requestId, undefined, undefined, true)).toBe(true);
    expect(h.events().find((event) => event.type === "takeover.end")?.data).toEqual({
      requestId,
      by: "user",
      declined: true,
    });
    const { result } = await asked;
    expect(result.ok).toBe(true);
    const words = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    expect(words.join(" ")).toMatch(/said not now.*find another way/);
    expect(result.content.some((part) => part.type === "image")).toBe(true);
    expect(h.events().some((event) => event.type === "message.user")).toBe(false);
  });

  it("has nothing to decline in control the user took themselves", async () => {
    const h = setup();
    const requestId = h.session.takeControl();
    await until(() => h.session.manualControl === "ready");
    expect(await h.session.handback(requestId, undefined, undefined, true)).toBe(true);
    expect(h.events().find((event) => event.type === "takeover.end")?.data).toEqual({
      requestId,
      by: "user",
    });
  });

  it("waits for a Pause that is still settling", () => {
    const h = setup();
    h.session.requestSafetyPause(ulid());
    expect(() => h.session.takeControl()).toThrow(PausedStepError);
    expect(h.session.controlHeld).toBe(false);
  });
});

describe("the take control route", () => {
  function routes(holder = false) {
    const home = mkdtempSync(join(tmpdir(), "localdot-take-control-")),
      log = new EventLog(home),
      id = log.createSession("Synthetic task"),
      cellId = ulid();
    const session = new AgentSession(id, cellId, "Synthetic task", log);
    if (!holder) session.beginBrain();
    const unused = () => {
      throw new Error("unexpected dependency access");
    };
    const deps: AgentRoutesDeps = {
      runner: {
        start: unused,
        get: (key) => (key === id ? session : undefined),
        raiseBudget: unused,
        holds: (key) => holder && key === id,
        hold: async (key) => {
          if (key !== cellId) throw new Error("unexpected computer");
          return { sessionId: id, requestId: session.takeControl() };
        },
      },
      settings: { get: unused, put: unused },
      catalog: { get: unused, refresh: unused },
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
      redactUserText: (text) => text,
      appendTo: unused,
      home,
    };
    const app = createApp({ token: "inert-token", port: 4747, eventLog: log });
    agentRoutes(app, deps);
    fixtures.push(() => {
      session.stop();
      log.close();
      rmSync(home, { force: true, recursive: true });
    });
    const post = (path: string, body?: unknown) =>
      app.request(`http://127.0.0.1:4747${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer inert-token",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const take = (path = id) => post(`/api/agent/sessions/${path}/takeover`);
    const snapshot = async () =>
      (await (
        await app.request(`http://127.0.0.1:4747/api/agent/sessions/${id}`, {
          headers: { authorization: "Bearer inert-token" },
        })
      ).json()) as Record<string, unknown>;
    return { session, cellId, post, take, snapshot };
  }

  it("hands the user the computer and names the control to hand back, once", async () => {
    const f = routes();
    const reply = await f.take();
    expect(reply.status).toBe(202);
    const { requestId } = (await reply.json()) as { requestId: string };
    expect(f.session.pendingTakeover).toBe(requestId);
    expect(await (await f.take()).json()).toEqual({ requestId });
    expect((await f.take(ulid())).status).toBe(404);
  });

  it("takes the computer with no task at work through the computer's own route", async () => {
    const f = routes(true);
    const reply = await f.post(`/api/cells/${f.cellId}/takeover`);
    expect(reply.status).toBe(202);
    expect(await reply.json()).toEqual({
      sessionId: f.session.id,
      requestId: f.session.pendingTakeover,
    });
    expect((await f.post("/api/cells/not-a-computer/takeover")).status).toBe(400);
  });

  it("marks the user's own hold, which takes no messages and no take once handed back", async () => {
    const f = routes(true);
    expect((await f.snapshot()).holder).toBe(true);
    const message = await f.post(`/api/agent/sessions/${f.session.id}/messages`, {
      kind: "followup",
      text: "Now save it",
    });
    expect(message.status).toBe(409);
    expect((await f.take()).status).toBe(409);
    expect(f.session.controlHeld).toBe(false);
  });

  it("hands dot's hand-off back on Not now", async () => {
    const f = routes();
    const asked = f.session.takeover("login", "Sign in");
    await until(() => f.session.manualControl === "ready");
    const requestId = required(f.session.pendingTakeover);
    const reply = await f.post(`/api/agent/sessions/${f.session.id}/takeover/done`, {
      requestId,
      declined: true,
    });
    expect(reply.status).toBe(204);
    expect(await asked).toEqual({ by: "user", declined: true });
  });

  it("refuses while a Pause is settling or the task has stopped", async () => {
    const f = routes();
    f.session.requestSafetyPause(ulid());
    expect((await f.take()).status).toBe(409);
    f.session.stop();
    expect((await f.take()).status).toBe(409);
    expect(f.session.controlHeld).toBe(false);
  });
});
