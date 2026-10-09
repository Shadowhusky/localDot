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
    expect(await h.session.handback(requestId, undefined)).toBe(true);
    expect(h.session.safetyPause).toMatchObject({ phase: "paused", resumeAvailable: true });
    expect(h.session.status).toBe("paused");
  });

  it("waits for a Pause that is still settling", () => {
    const h = setup();
    h.session.requestSafetyPause(ulid());
    expect(() => h.session.takeControl()).toThrow(PausedStepError);
    expect(h.session.controlHeld).toBe(false);
  });
});

describe("the take control route", () => {
  function routes() {
    const home = mkdtempSync(join(tmpdir(), "localdot-take-control-")),
      log = new EventLog(home),
      id = log.createSession("Synthetic task");
    const session = new AgentSession(id, ulid(), "Synthetic task", log);
    session.beginBrain();
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
      catalog: { get: unused, refresh: unused },
      keyd: { secrets: unused },
      memory: { readBoth: unused, undo: unused },
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
    const take = (path = id) =>
      app.request(`http://127.0.0.1:4747/api/agent/sessions/${path}/takeover`, {
        method: "POST",
        headers: { authorization: "Bearer inert-token" },
      });
    return { session, take };
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

  it("refuses while a Pause is settling or the task has stopped", async () => {
    const f = routes();
    f.session.requestSafetyPause(ulid());
    expect((await f.take()).status).toBe(409);
    f.session.stop();
    expect((await f.take()).status).toBe(409);
    expect(f.session.controlHeld).toBe(false);
  });
});
