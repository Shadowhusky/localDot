import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AlwaysOption, type AutonomyRule, DEFAULT_AUTONOMY, ulid } from "@localdot/protocol";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { type AgentRoutesDeps, agentRoutes } from "./routes.ts";
import { decideAutonomy } from "./safety/autonomy.ts";
import { RulesStore } from "./safety/rules.ts";
import { AgentSession } from "./session.ts";
import type { ToolCallContext } from "./tools/deps.ts";

const MAIL = "https://mail.example.test";
const onMail: AlwaysOption = { scope: "site", label: "On mail.example.test", site: MAIL };
const TOKEN = "r".repeat(43);
function saved(rule: AutonomyRule | undefined): AutonomyRule {
  if (!rule) throw new Error("expected a new rule");
  return rule;
}
const owned: { home: string; session: AgentSession }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.session.stop();
    rmSync(item.home, { recursive: true, force: true });
  }
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-rules-routes-"));
  const events: { type: string; data: unknown }[] = [];
  const rules = new RulesStore(home);
  const session = new AgentSession(
    ulid(),
    ulid(),
    "task",
    {
      append: (_id, event) => {
        events.push(event);
        return undefined as never;
      },
    },
    DEFAULT_AUTONOMY,
    rules,
  );
  session.beginBrain();
  owned.push({ home, session });
  const deps = {
    runner: {
      start: vi.fn(),
      get: (id: string) => (id === session.id ? session : undefined),
      raiseBudget: vi.fn(),
      sessions: new Map([[session.id, session]]),
    },
    settings: { get: () => ({}), put: vi.fn() },
    catalog: { get: () => undefined, refresh: vi.fn() },
    keyd: { secrets: async () => [] },
    memory: { readBoth: vi.fn(), undo: vi.fn() },
    skills: () => [],
    home,
    desktop: () => undefined,
    redactUserText: (text: string) => text,
    appendTo: vi.fn(),
  } as unknown as AgentRoutesDeps;
  const app = new Hono();
  agentRoutes(app, deps);
  const send = (method: string, path: string) => app.request(`http://127.0.0.1${path}`, { method });
  const sendDecision = () =>
    decideAutonomy({ session, screen: undefined } as unknown as ToolCallContext, {
      operation: "click",
      target: { source: "dom", fresh: true, role: "button", name: "Send", url: `${MAIL}/x` },
    }).mode;
  return { home, rules, session, events, deps, app, send, sendDecision };
}

describe("Always allow routes", () => {
  it("lists saved rules and removes one, which tightens the next decision", async () => {
    const f = setup();
    const rule = saved(f.rules.add("send", onMail, ulid()));
    expect(f.sendDecision()).toBe("act");
    const listed = await f.send("GET", "/api/agent/rules");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ rules: [rule] });

    expect((await f.send("DELETE", `/api/agent/rules/${rule.id}`)).status).toBe(204);
    expect(f.sendDecision()).toBe("ask");
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "rule.removed",
        data: {
          id: rule.id,
          scope: "site",
          actionClass: "send",
          label: "On mail.example.test",
          site: MAIL,
        },
      }),
    );
    expect(await (await f.send("GET", "/api/agent/rules")).json()).toEqual({ rules: [] });
    expect((await f.send("DELETE", `/api/agent/rules/${rule.id}`)).status).toBe(404);
    expect((await f.send("DELETE", "/api/agent/rules/not-a-rule")).status).toBe(400);
  });

  it("shows an unreadable rules.json as an error and leaves it alone", async () => {
    const f = setup();
    writeFileSync(join(f.home, "rules.json"), "{", { mode: 0o600 });
    const listed = await f.send("GET", "/api/agent/rules");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      rules: [],
      error: expect.stringMatching(/could not be read/),
    });
    expect((await f.send("DELETE", `/api/agent/rules/${ulid()}`)).status).toBe(409);
  });

  it("sets an unreadable rules.json aside so new choices can be saved", async () => {
    const f = setup();
    writeFileSync(join(f.home, "rules.json"), "{", { mode: 0o600 });
    expect((await f.send("POST", "/api/agent/rules/reset")).status).toBe(204);
    expect(await (await f.send("GET", "/api/agent/rules")).json()).toEqual({ rules: [] });
    expect(readdirSync(f.home).filter((name) => name.startsWith("rules.json."))).toHaveLength(1);
    expect((await f.send("POST", "/api/agent/rules/reset")).status).toBe(409);
    expect(saved(f.rules.add("send", onMail, ulid()))).toMatchObject({ site: MAIL });
  });

  it("saves only a scope the card offered and lets the answer name nothing else", async () => {
    const f = setup();
    const generation = f.session.generation;
    if (!generation) throw new Error("no generation");
    const outcome = f.session.requestApproval(
      {
        sessionId: f.session.id,
        cellId: f.session.cellId,
        generation: generation.id,
        callId: ulid(),
        digest: "d".repeat(64),
        targetDigest: "t".repeat(64),
      },
      {
        actionClass: "send",
        risk: "high",
        title: "Send as you",
        fields: [],
        always: [{ scope: "task", label: "For this task" }, onMail],
      },
      { signal: new AbortController().signal, check() {}, revalidate: async () => true },
    );
    const card = f.session.pendingApproval;
    if (!card) throw new Error("no card");
    const ids = {
      approvalId: card.approvalId,
      generation: card.generation,
      revision: card.revision,
    };
    const answer = (body: Record<string, unknown>) =>
      f.app.request(`http://127.0.0.1/api/agent/sessions/${f.session.id}/approvals/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...ids, ...body }),
      });
    expect((await answer({ decision: "approve", always: "always" })).status).toBe(409);
    expect((await answer({ decision: "approve", always: "app" })).status).toBe(409);
    for (const forged of [
      { decision: "approve", always: "site", site: "https://evil.example.test" },
      { decision: "approve", always: "site", actionClass: "computer" },
      { decision: "deny", always: "task" },
    ])
      expect((await answer(forged)).status).toBe(400);
    expect(f.session.pendingApproval?.approvalId).toBe(card.approvalId);
    expect(f.rules.list()).toEqual({ rules: [] });
    expect((await answer({ decision: "approve", always: "site" })).status).toBe(204);
    expect(await outcome).toBe("approve");
    expect(f.rules.list().rules).toMatchObject([
      { actionClass: "send", scope: "site", site: MAIL },
    ]);
  });

  it("undoes a task allowance", async () => {
    const f = setup();
    f.session.taskAutonomy.grant("send", { scope: "task", label: "For this task" }, ulid());
    expect(f.sendDecision()).toBe("act");
    const path = `/api/agent/sessions/${f.session.id}/allowances/send`;
    expect((await f.send("DELETE", path)).status).toBe(204);
    expect(f.sendDecision()).toBe("ask");
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "rule.removed",
        data: { scope: "task", actionClass: "send", label: "For this task" },
      }),
    );
    expect((await f.send("DELETE", path)).status).toBe(404);
    expect(
      (await f.send("DELETE", `/api/agent/sessions/${f.session.id}/allowances/everything`)).status,
    ).toBe(400);
    expect((await f.send("DELETE", `/api/agent/sessions/${ulid()}/allowances/send`)).status).toBe(
      404,
    );
  });

  it("leaves a stopped task's allowances and log alone", async () => {
    const f = setup();
    f.session.taskAutonomy.grant("send", { scope: "task", label: "For this task" }, ulid());
    f.session.stop();
    const before = f.events.length;
    expect(
      (await f.send("DELETE", `/api/agent/sessions/${f.session.id}/allowances/send`)).status,
    ).toBe(409);
    expect(f.events.slice(before).map((event) => event.type)).not.toContain("rule.removed");
  });

  it("sits behind the install token and the Origin check", async () => {
    const f = setup();
    const rule = saved(f.rules.add("send", onMail, ulid()));
    f.session.taskAutonomy.grant("send", { scope: "task", label: "For this task" }, ulid());
    const log = new EventLog(f.home);
    const app = createApp({ token: TOKEN, port: 4783, eventLog: log, agent: f.deps });
    const call = (method: string, path: string, headers: Record<string, string> = {}) =>
      app.request(`http://127.0.0.1:4783${path}`, { method, headers });
    const allowance = `/api/agent/sessions/${f.session.id}/allowances/send`;
    try {
      for (const [method, path] of [
        ["GET", "/api/agent/rules"],
        ["DELETE", `/api/agent/rules/${rule.id}`],
        ["POST", "/api/agent/rules/reset"],
        ["DELETE", allowance],
      ] as const) {
        expect((await call(method, path)).status).toBe(401);
        expect(
          (await call(method, path, { authorization: `Bearer ${"x".repeat(43)}` })).status,
        ).toBe(401);
        expect(
          (
            await call(method, path, {
              authorization: `Bearer ${TOKEN}`,
              origin: "https://evil.example.test",
            })
          ).status,
        ).toBe(403);
      }
      expect(f.rules.list().rules).toEqual([rule]);
      expect(f.sendDecision()).toBe("act");
      const auth = { authorization: `Bearer ${TOKEN}`, origin: "http://127.0.0.1:4783" };
      expect((await call("GET", "/api/agent/rules", auth)).status).toBe(200);
      expect((await call("POST", "/api/agent/rules/reset", auth)).status).toBe(409);
      expect((await call("DELETE", `/api/agent/rules/${rule.id}`, auth)).status).toBe(204);
      expect((await call("DELETE", allowance, auth)).status).toBe(204);
      expect(f.sendDecision()).toBe("ask");
    } finally {
      log.close();
    }
  });
});

describe("a connection's card", () => {
  it("is answered through the task's approval route whatever the brain is doing, and its Always is listed", async () => {
    const f = setup();
    const { session, app } = f;
    const decision = session.connections.request({
      app: "wechat",
      host: "chat.example.com",
      port: 5222,
      why: "wechat hasn't used this destination before.",
    });
    const card = session.connections.pending;
    if (!card) throw new Error("no card");
    const generation = session.generation;
    if (generation) session.retireBrain(generation);
    const post = (body: unknown) =>
      app.request(`http://127.0.0.1/api/agent/sessions/${session.id}/approvals/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const answer = {
      approvalId: card.approvalId,
      generation: card.generation,
      revision: card.revision,
      decision: "approve",
      always: "destination",
    };
    expect((await post({ ...answer, revision: card.revision + 1 })).status).toBe(409);
    expect((await post(answer)).status).toBe(204);
    await expect(decision).resolves.toMatchObject({ allow: true });
    const listed = (await (await f.send("GET", "/api/agent/rules")).json()) as {
      rules: AutonomyRule[];
    };
    expect(listed.rules).toMatchObject([
      {
        actionClass: "network",
        scope: "destination",
        destination: "chat.example.com:5222",
        app: "wechat",
        label: "Always for wechat on chat.example.com",
      },
    ]);
    expect((await post(answer)).status).toBe(409);
  });
});
