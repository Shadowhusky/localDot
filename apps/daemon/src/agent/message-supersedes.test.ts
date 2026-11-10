import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { redactor } from "./redact.ts";
import { type AgentRoutesDeps, agentRoutes } from "./routes.ts";
import type { MessageTurn } from "./session.ts";
import { PROXY_TOKEN, toolHarness } from "./testing/harness.ts";
import { dispatchTool } from "./tools/index.ts";

const fixtures: (() => void)[] = [];
afterEach(() => {
  for (const close of fixtures.splice(0)) close();
});

const TOKEN = "inert-token";
const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((part) => part.text ?? "").join("\n");
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the fixture never got there");
};

// The real routes and tools over the fake computer, with no one answering for the user.
function setup({ guest = false, turn }: { guest?: boolean; turn?: Partial<MessageTurn> } = {}) {
  const h = toolHarness({ autoApprove: false });
  fixtures.push(h.close);
  const unused = () => {
    throw new Error("unexpected dependency access");
  };
  const deps: AgentRoutesDeps = {
    runner: {
      start: unused,
      get: (key: string) => (key === h.session.id ? h.session : undefined),
      raiseBudget: unused,
      ...(turn
        ? {
            messageTurn: async () =>
              ({
                model: { provider: "openai", model: "gpt-6-luna" },
                ref: {},
                moves: () => true,
                reached: () => {},
                ...turn,
              }) as MessageTurn,
          }
        : {}),
    } as never,
    settings: { get: unused, put: unused },
    catalog: {
      fresh() {
        return Promise.resolve(this.get());
      },
      freshness: () => ({ stale: false, refreshing: false, refreshFailed: false }),
      get: unused,
      refresh: unused,
    },
    keyd: { secrets: async () => [] },
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
    home: h.home,
  };
  const app = createApp({ token: TOKEN, port: 4747, eventLog: h.eventLog });
  if (guest)
    app.use("/api/agent/*", async (c, next) => {
      c.set("remoteGrant", { id: "guest" } as never);
      await next();
    });
  agentRoutes(app, deps);
  const post = (path: string, body: unknown) =>
    app.request(`http://127.0.0.1:4747/api/agent/sessions/${h.session.id}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const say = (text: string, kind: "steer" | "followup" = "steer", model?: unknown) =>
    post("/messages", { text, kind, ...(model ? { model } : {}) });
  const redact = redactor([PROXY_TOKEN]);
  const call = (name: string, input: unknown, callId = "call") =>
    dispatchTool({ tools: h.tools }, h.session, name, callId, input, redact);
  const unread = async () => (await h.session.inbox(0, 0)).items;
  return { ...h, post, say, call, unread };
}

const QUICK = { question: "Which format?", options: ["PDF", "Word"] };
const SEND = { command: "rm -rf build" };
const USER_WORDS = "Forget the report, book the train instead";
// The newest message of the user's, as it is on record.
const newest = (f: ReturnType<typeof setup>) => {
  const said = f.events().findLast((event) => event.type === "message.user");
  if (said?.type !== "message.user") throw new Error("no message on record");
  return said.data;
};

describe("a message while dot waits on a question", () => {
  it("ends the question and reaches dot at once, not as its answer", async () => {
    const f = setup();
    const waiting = f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    const askId = f.session.pendingAsk;
    expect((await f.say(USER_WORDS)).status).toBe(202);

    expect(f.session.pendingAsk).toBeUndefined();
    const { result } = await waiting;
    expect(result.ok).toBe(true);
    expect(textOf(result)).toMatch(/instead of answering/);
    expect(textOf(result)).toMatch(/only if you still need/i);
    // Their words come as their message, never as an answer in the tool's reply.
    expect(textOf(result)).not.toContain(USER_WORDS);

    const answers = f.events().filter((event) => event.type === "ask.answer");
    expect(answers.map((event) => event.data)).toEqual([{ askId, by: "message" }]);
    expect(newest(f)).toMatchObject({ text: USER_WORDS, kind: "steer" });
    expect(newest(f).queued).toBeUndefined();
    expect(await f.unread()).toEqual([
      expect.objectContaining({ kind: "steer", text: USER_WORDS }),
    ]);
    expect(f.session.status).toBe("running");
  });

  it("shows on the message that dot stopped waiting to read it", async () => {
    const f = setup();
    void f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    await f.say(USER_WORDS);
    expect(
      f
        .events()
        .filter((event) => event.type === "message.delivery")
        .at(-1)?.data,
    ).toEqual({ messageId: newest(f).messageId, state: "woke" });
    // That message has ended its wait: a wait dot starts next runs on.
    const next = f.session.listenForUser(new AbortController().signal);
    expect(next.spoke).toBe(false);
    next.end();
  });

  it("refuses a late answer or Not now, on any device", async () => {
    const f = setup();
    void f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    const askId = f.session.pendingAsk;
    await f.say(USER_WORDS);
    const late = await f.post("/answer", { askId, fields: { answer: "PDF" } });
    expect(late.status).toBe(409);
    expect(await late.text()).toBe("that question is not waiting");
    expect((await f.post("/answer", { askId, declined: true })).status).toBe(409);
    expect(f.events().filter((event) => event.type === "ask.answer")).toHaveLength(1);
  });

  it("moves on for a message sent as for after this task, and any file it carries", async () => {
    const f = setup();
    const waiting = f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    expect((await f.say(USER_WORDS, "followup")).status).toBe(202);
    expect((await waiting).result.ok).toBe(true);
    expect(await f.unread()).toEqual([
      expect.objectContaining({ kind: "steer", text: USER_WORDS }),
    ]);
  });

  it("moves on for a queued message the user steers with now", async () => {
    const f = setup();
    f.session.enqueue("After this, tidy the folder");
    const { messageId } = newest(f);
    const waiting = f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    expect((await f.post(`/messages/${messageId}/steer`, {})).status).toBe(204);
    expect(f.session.pendingAsk).toBeUndefined();
    expect(textOf((await waiting).result)).toMatch(/instead of answering/);
    expect(await f.unread()).toEqual([
      expect.objectContaining({ kind: "steer", text: "After this, tidy the folder" }),
    ]);
  });

  it("leaves the wait alone for a shared link's guest, who answers for no one", async () => {
    const f = setup({ guest: true });
    void f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    const askId = f.session.pendingAsk;
    expect((await f.say("Hello?")).status).toBe(202);
    expect(f.session.pendingAsk).toBe(askId);
    expect(f.events().filter((event) => event.type === "ask.answer")).toEqual([]);
  });

  it("ends the wait for a model this task can't run, and tells dot to finish for it", async () => {
    const handOver = vi.fn();
    const f = setup({ turn: { handOver } });
    const waiting = f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    const model = { provider: "openai", key: "k", model: "gpt-6-luna" };
    expect((await f.say(USER_WORDS, "steer", model)).status).toBe(202);
    expect(f.session.pendingAsk).toBeUndefined();
    expect(textOf((await waiting).result)).toMatch(/after this task/);
    expect(await f.unread()).toEqual([]);
    f.session.setStatus("idle");
    expect(handOver).toHaveBeenCalledOnce();
  });

  it("takes a message for another model straight to it when moving dot ends nothing", async () => {
    const reached = vi.fn();
    const f = setup({ turn: { reached } });
    const waiting = f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    const model = { provider: "openai", key: "k", model: "gpt-6-luna" };
    expect((await f.say(USER_WORDS, "steer", model)).status).toBe(202);
    expect(reached).toHaveBeenCalledOnce();
    expect((await waiting).result.ok).toBe(true);
    expect(await f.unread()).toEqual([
      expect.objectContaining({ kind: "steer", text: USER_WORDS }),
    ]);
  });

  it("lets a message for another model wait while dot has a command running, and ends the wait", async () => {
    const reached = vi.fn();
    const f = setup({ turn: { reached } });
    const lease = f.session.leaveRunning(
      f.session.generation as never,
      f.session.post("steer", "Leave that running"),
    );
    const heard = (await f.session.inbox(0, 0)).items.at(-1)?.seq ?? 0;
    f.session.heard(heard);
    const waiting = f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    const model = { provider: "openai", key: "k", model: "gpt-6-luna" };
    expect((await f.say(USER_WORDS, "steer", model)).status).toBe(202);
    expect(reached).not.toHaveBeenCalled();
    expect(textOf((await waiting).result)).toMatch(/after this task/);
    expect(f.session.generation).toBeDefined();
    f.session.commandEnded(lease);
  });

  it("never treats a message as heard before a wait it did not end", async () => {
    const f = setup();
    // Sent while dot worked, before it asked: it doesn't close a question asked after it.
    f.session.post("steer", "Prefer the morning train");
    void f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    expect(f.session.pendingAsk).toBeDefined();
  });
});

describe("a message while dot waits on a form with something private in it", () => {
  const SECRET_CANARY = "correct horse battery staple 42";
  const PASSWORD = {
    point: { x: 800, y: 600 },
    bbox: { x: 640, y: 580, w: 320, h: 40 },
    source: "dom",
    role: "textbox",
    name: "Password",
    app: "chromium",
    window: "Sign in",
    url: "https://router.lan/login",
    secret: true,
  };
  const stored = (home: string) =>
    readdirSync(home, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"))
      .join("\n");
  function withDevice(f: ReturnType<typeof setup>) {
    const typed: unknown[] = [];
    const hit = {
      target: PASSWORD,
      window: 7,
      windowFrame: { x: 0, y: 0, w: 2560, h: 1600 },
      ms: 1,
    };
    f.tools.device = () =>
      ({
        client: {
          hitTest: async () => hit,
          focused: async () => hit,
          input: async () => ({ pressMono: 1, presses: [1], injector: "xtest", armedMono: 0 }),
          type: async (request: unknown) => {
            typed.push(request);
            return { done: true, count: 1, firstPressMono: 1, injector: "xtest", armedMono: 0 };
          },
        },
      }) as never;
    return typed;
  }

  it.each([
    ["a password", { id: "password", kind: "secret", label: "Password", target: [400, 300] }],
    ["a code", { id: "code", kind: "code", label: "Code", length: 6, target: [400, 300] }],
  ])("closes %s form with nothing typed, stored or told", async (_kind, field) => {
    const f = setup();
    const typed = withDevice(f);
    const waiting = f.call("ask_user", {
      question: "Sign in to your router",
      fields: [field],
      submit: "Sign in",
      decline: "Not now",
    });
    await until(() => !!f.session.pendingAsk);
    const askId = f.session.pendingAsk;
    expect((await f.say("Actually skip the router")).status).toBe(202);
    const { result } = await waiting;
    expect(result.ok).toBe(true);
    expect(textOf(result)).toMatch(/nothing was entered/);
    expect(typed).toEqual([]);
    expect(
      f
        .events()
        .filter((event) => event.type === "ask.answer")
        .map((e) => e.data),
    ).toEqual([{ askId, by: "message" }]);
    // A late answer with the secret goes nowhere: refused before it is read, and never kept.
    const late = await f.post("/answer", { askId, fields: { [field.id]: SECRET_CANARY } });
    expect(late.status).toBe(409);
    expect(typed).toEqual([]);
    expect(stored(f.home)).not.toContain(SECRET_CANARY);
  });

  it("closes a key's form without taking it for the user's refusal", async () => {
    const f = setup();
    f.tools.credentials = { list: async () => [] } as never;
    const waiting = f.call("credentials", {
      action: "request",
      key_id: "weather",
      hosts: ["api.example.test"],
      label: "Weather",
    });
    await until(() => !!f.session.pendingAsk);
    await f.say("Use the other host instead");
    const { result } = await waiting;
    expect(textOf(result)).toMatch(/instead of answering/);
    expect(textOf(result)).not.toMatch(/Respect this choice/);
  });

  it("closes an app's connection form, taking back the app dot added for it", async () => {
    const f = setup();
    const remove = vi.fn(async () => {});
    f.tools.connectors = {
      connectTarget: () => ({
        config: { id: "linear", name: "Linear" },
        host: "mcp.linear.app",
        added: true,
      }),
      isConnected: () => false,
      remove,
    } as never;
    const waiting = f.call("credentials", { action: "connect", app: "Linear" });
    await until(() => !!f.session.pendingAsk);
    await f.say("Skip Linear");
    expect(textOf((await waiting).result)).toMatch(/instead of answering/);
    expect(remove).toHaveBeenCalledWith("linear");
  });
});

describe("a message while a step waits on the user's OK", () => {
  it("counts as not approved: the step never runs, and dot hears why", async () => {
    const f = setup();
    const waiting = f.call("shell", SEND);
    await until(() => !!f.session.pendingApproval);
    const card = f.session.pendingApproval;
    expect((await f.say(USER_WORDS)).status).toBe(202);
    expect(f.session.pendingApproval).toBeUndefined();
    const { result } = await waiting;
    expect(result.ok).toBe(false);
    expect(textOf(result)).toMatch(/not approved/);
    expect(textOf(result)).toMatch(/did not run/);
    expect(textOf(result)).toMatch(/ask again/i);
    expect(f.desktop.shellCalls).toEqual([]);
    const resolved = f.events().filter((event) => event.type === "approval.resolve");
    expect(resolved.map((event) => event.data)).toEqual([
      expect.objectContaining({ approvalId: card?.approvalId, decision: "deny", by: "message" }),
    ]);
    expect(f.events().some((event) => event.type === "rule.created")).toBe(false);
    expect(await f.unread()).toEqual([
      expect.objectContaining({ kind: "steer", text: USER_WORDS }),
    ]);
    expect(f.session.status).toBe("running");
  });

  it("refuses a late Approve, and the action stays unrun", async () => {
    const f = setup();
    void f.call("shell", SEND);
    await until(() => !!f.session.pendingApproval);
    const card = f.session.pendingApproval;
    await f.say(USER_WORDS);
    const late = await f.post("/approvals/answer", {
      approvalId: card?.approvalId,
      generation: card?.generation,
      revision: card?.revision,
      decision: "approve",
      always: "task",
    });
    expect(late.status).toBe(409);
    expect(f.desktop.shellCalls).toEqual([]);
    expect(f.events().some((event) => event.type === "rule.created")).toBe(false);
  });

  it("makes dot ask again if it still wants the step", async () => {
    const f = setup();
    void f.call("shell", SEND, "first");
    await until(() => !!f.session.pendingApproval);
    const first = f.session.pendingApproval;
    await f.say(USER_WORDS);
    await until(() => !f.session.pendingApproval);
    const again = f.call("shell", SEND, "second");
    await until(() => !!f.session.pendingApproval);
    const second = f.session.pendingApproval;
    expect(second?.approvalId).not.toBe(first?.approvalId);
    expect(f.desktop.shellCalls).toEqual([]);
    expect(
      f.session.answerApproval({
        approvalId: second?.approvalId,
        generation: second?.generation,
        revision: second?.revision,
        decision: "approve",
      }),
    ).toBe(true);
    await again;
    expect(f.desktop.shellCalls).toEqual(["rm -rf build"]);
  });

  it("stops an action on the computer the same way, its screen still in the reply", async () => {
    const f = setup();
    const pressed: unknown[] = [];
    const identity = { target: null, window: 9, point: { x: 400, y: 364 } };
    f.tools.gateway = {
      ...f.tools.gateway,
      run: async (ctx: never, action: never) => {
        const { authorizeAgent } = ctx as {
          authorizeAgent(request: unknown): Promise<unknown>;
        };
        const permit = await authorizeAgent({ action, identity, revalidate: async () => true });
        if (!permit) return { ok: false, cancelled: "user", error: "not authorized" };
        pressed.push(action);
        return { ok: true, frameId: ulid() };
      },
    } as never;
    const waiting = f.call("computer", { action: "key", keys: ["bracketright"], repeat: 5 });
    await until(() => !!f.session.pendingApproval);
    await f.say(USER_WORDS);
    const { result } = await waiting;
    expect(result.ok).toBe(false);
    expect(textOf(result)).toMatch(/not approved/);
    expect(textOf(result)).not.toMatch(/not authorized/);
    expect(pressed).toEqual([]);
  });

  it("leaves an app's connection card waiting: dot isn't waiting on it", async () => {
    const f = setup();
    const decided = vi.fn();
    void f.session.connections
      .request({ app: "WeChat", host: "long.weixin.qq.com", port: 8080, why: async () => "new" })
      .then(decided);
    await until(() => !!f.session.connections.pending);
    expect((await f.say("Carry on with the report")).status).toBe(202);
    expect(f.session.connections.pending).toBeDefined();
    expect(decided).not.toHaveBeenCalled();
    expect(await f.unread()).toEqual([
      expect.objectContaining({ kind: "steer", text: "Carry on with the report" }),
    ]);
  });
});

describe("a message while dot waits on the computer it handed over", () => {
  const asks = (f: ReturnType<typeof setup>) => {
    const waiting = f.call("request_takeover", { reason: "login", note: "Please sign in" });
    return { waiting, held: until(() => f.session.manualControl === "ready") };
  };

  it("ends the hand-over, gives the computer back and tells dot what happened", async () => {
    const f = setup();
    const { waiting, held } = asks(f);
    await held;
    const requestId = f.session.pendingTakeover;
    expect((await f.say(USER_WORDS)).status).toBe(202);
    expect(f.session.controlHeld).toBe(false);
    const { result } = await waiting;
    expect(result.ok).toBe(true);
    expect(textOf(result)).toMatch(/sent a message/);
    expect(textOf(result)).not.toContain(USER_WORDS);
    expect(
      f
        .events()
        .filter((event) => event.type === "takeover.end")
        .map((e) => e.data),
    ).toEqual([{ requestId, note: USER_WORDS, by: "user", movedOn: true }]);
    expect(await f.unread()).toEqual([
      expect.objectContaining({ kind: "steer", text: USER_WORDS }),
    ]);
  });

  it("refuses a late hand-back once a message ended it", async () => {
    const f = setup();
    const { held } = asks(f);
    await held;
    const requestId = f.session.pendingTakeover;
    await f.say(USER_WORDS);
    expect((await f.post("/takeover/done", { requestId })).status).toBe(409);
  });

  it("hands back the computer the page already took for the user, by the same rule", async () => {
    const f = setup();
    const { waiting, held } = asks(f);
    await held;
    f.session.takeControl();
    await f.say(USER_WORDS);
    expect(textOf((await waiting).result)).toMatch(/sent a message/);
    expect(f.session.controlHeld).toBe(false);
  });

  it("keeps the rule for computer the user took themselves: Send hands it back", async () => {
    const f = setup();
    const requestId = f.session.takeControl();
    await until(() => f.session.manualControl === "ready");
    expect((await f.say("Now carry on")).status).toBe(202);
    expect(f.session.controlHeld).toBe(false);
    const ends = f.events().filter((event) => event.type === "takeover.end");
    expect(ends.map((event) => event.data)).toEqual([
      { requestId, note: "Now carry on", by: "user" },
    ]);
  });
});

describe("a message while a card in the conversation is up", () => {
  const raises = (f: ReturnType<typeof setup>) =>
    f.events().filter((event) => event.type === "blocker.raise");
  const clears = (f: ReturnType<typeof setup>) =>
    f.events().flatMap((event) => (event.type === "blocker.clear" ? [event.data] : []));
  const APP = { kind: "app", connector: "gh", name: "GitHub", host: "api.example" } as const;

  it("ends dot's wait on it, and closes it as not done", async () => {
    const f = setup();
    f.tools.keysLocked = () => true;
    const waiting = f.call("request_fix", { kind: "keys_locked" });
    await until(() => f.session.openBlockers.length === 1);
    const blockerId = f.session.openBlockers[0]?.blockerId;
    expect((await f.say(USER_WORDS)).status).toBe(202);

    expect(f.session.openBlockers).toEqual([]);
    const { result } = await waiting;
    expect(result.ok).toBe(true);
    expect(textOf(result)).toMatch(/instead of fixing this/);
    expect(textOf(result)).toMatch(/only if you still need/i);
    expect(textOf(result)).not.toContain(USER_WORDS);
    expect(clears(f)).toEqual([{ blockerId, outcome: "moved_on" }]);
    expect(newest(f)).toMatchObject({ text: USER_WORDS, kind: "steer" });
    expect(newest(f).queued).toBeUndefined();
    expect(await f.unread()).toEqual([
      expect.objectContaining({ kind: "steer", text: USER_WORDS }),
    ]);
    expect(
      f
        .events()
        .filter((event) => event.type === "message.delivery")
        .map((event) => event.data),
    ).toEqual([{ messageId: newest(f).messageId, state: "woke" }]);
    expect(f.session.status).toBe("running");
  });

  it("is the same path for a queued message the user steers with now", async () => {
    const f = setup();
    f.tools.keysLocked = () => true;
    const waiting = f.call("request_fix", { kind: "keys_locked" });
    await until(() => f.session.openBlockers.length === 1);
    f.session.enqueue(USER_WORDS);
    const queued = f.events().findLast((event) => event.type === "message.user");
    if (queued?.type !== "message.user") throw new Error("nothing queued");
    expect((await f.post(`/messages/${queued.data.messageId}/steer`, {})).status).toBe(204);
    expect(f.session.openBlockers).toEqual([]);
    expect(textOf((await waiting).result)).toMatch(/instead of fixing this/);
    expect(clears(f)[0]).toMatchObject({ outcome: "moved_on" });
  });

  it("closes a card dot wasn't waiting on, leaving the message to its usual path", async () => {
    const f = setup();
    f.session.raiseBlocker(APP);
    expect((await f.say(USER_WORDS)).status).toBe(202);
    expect(f.session.openBlockers).toEqual([]);
    expect(clears(f)[0]).toMatchObject({ outcome: "moved_on" });
    const heard = await f.unread();
    expect(heard.at(-2)?.text).toMatch(/instead of reconnecting GitHub/);
    expect(heard.at(-1)).toMatchObject({ kind: "steer", text: USER_WORDS });
    expect(f.events().some((event) => event.type === "message.delivery")).toBe(false);
  });

  it("never treats a card dot wasn't waiting on as the wait the message ended", async () => {
    const f = setup();
    f.session.raiseBlocker(APP);
    const listening = f.session.listenForUser(new AbortController().signal);
    await f.say(USER_WORDS);
    expect(listening.spoke).toBe(true);
    listening.end();
  });

  it("resumes nothing when the blocker clears afterwards", async () => {
    const f = setup();
    f.tools.keysLocked = () => true;
    const waiting = f.call("request_fix", { kind: "keys_locked" });
    await until(() => f.session.openBlockers.length === 1);
    await f.say(USER_WORDS);
    await waiting;
    const seq = f.session.inboxSequence;
    const closed = clears(f).length;
    f.session.keysUnlocked();
    expect(f.session.inboxSequence).toBe(seq);
    expect(clears(f)).toHaveLength(closed);
    expect(f.session.keysLocked).toBe(false);
  });

  it("lets dot raise it again if it still needs it", async () => {
    const f = setup();
    f.tools.keysLocked = () => true;
    const first = f.call("request_fix", { kind: "keys_locked" });
    await until(() => f.session.openBlockers.length === 1);
    await f.say(USER_WORDS);
    await first;
    const again = f.call("request_fix", { kind: "keys_locked" });
    await until(() => f.session.openBlockers.length === 1);
    expect(raises(f)).toHaveLength(2);
    for (const open of f.session.openBlockers) f.session.useBlocker(open.blockerId);
    f.session.keysUnlocked();
    expect((await again).result.ok).toBe(true);
  });

  it("moves a stalled model on: the message wakes it, and a new stall raises a new card", async () => {
    const f = setup();
    f.session.setStatus("paused");
    const stalled = f.session.raiseBlocker(
      { kind: "model", reason: "model refused" },
      { required: true, tell: false },
    );
    expect((await f.say(USER_WORDS)).status).toBe(202);
    expect(f.session.openBlockers).toEqual([]);
    expect(clears(f)).toEqual([{ blockerId: stalled?.blockerId, outcome: "moved_on" }]);
    // The message, then the Resume a plan's harness waits for, in that order.
    expect((await f.unread()).map((item) => item.kind)).toEqual(["steer", "resume"]);
    expect((await f.unread())[0]?.text).toBe(USER_WORDS);
    const next = f.session.raiseBlocker(
      { kind: "model", reason: "model refused" },
      { required: true, tell: false },
    );
    expect(next?.blockerId).not.toBe(stalled?.blockerId);
  });

  it("takes a stalled task straight to a model it can't run, which it could never finish for", async () => {
    const handOver = vi.fn();
    const f = setup({ turn: { handOver } });
    f.session.setStatus("paused");
    f.session.raiseBlocker(
      { kind: "model", reason: "provider limit reached" },
      { required: true, tell: false },
    );
    const model = { provider: "chatgpt", model: "gpt-6-sol" };
    expect((await f.say(USER_WORDS, "steer", model)).status).toBe(202);
    expect(handOver).toHaveBeenCalledOnce();
    expect(f.session.openBlockers).toEqual([]);
  });

  it("tells a waiting dot to finish when the message goes on after this task", async () => {
    const f = setup({ turn: { handOver: () => {} } });
    f.tools.keysLocked = () => true;
    const waiting = f.call("request_fix", { kind: "keys_locked" });
    await until(() => f.session.openBlockers.length === 1);
    const model = { provider: "chatgpt", model: "gpt-6-sol" };
    expect((await f.say(USER_WORDS, "steer", model)).status).toBe(202);
    expect(textOf((await waiting).result)).toMatch(/goes on after this task/);
  });

  it("leaves the card up for a shared link's guest, who answers for no one", async () => {
    const f = setup({ guest: true });
    f.tools.keysLocked = () => true;
    const waiting = f.call("request_fix", { kind: "keys_locked" });
    await until(() => f.session.openBlockers.length === 1);
    expect((await f.say(USER_WORDS)).status).not.toBe(500);
    expect(f.session.openBlockers).toHaveLength(1);
    expect(clears(f)).toEqual([]);
    for (const open of f.session.openBlockers) f.session.useBlocker(open.blockerId);
    f.session.keysUnlocked();
    expect((await waiting).result.ok).toBe(true);
  });

  it("refuses a late Not now, on any device", async () => {
    const f = setup();
    const open = f.session.raiseBlocker(APP);
    await f.say(USER_WORDS);
    expect(f.session.dismissBlocker(open?.blockerId ?? "")).toBe(false);
    const model = { provider: "chatgpt", model: "gpt-6-sol" };
    expect((await f.post(`/blockers/${open?.blockerId}/model`, { model })).status).toBe(409);
  });
});

describe("the wait kinds a message leaves as they are", () => {
  it("sends as before when dot isn't waiting on anything", async () => {
    const f = setup();
    expect((await f.say("Check the logs")).status).toBe(202);
    expect((await f.say("Then rest", "followup")).status).toBe(202);
    expect(await f.unread()).toEqual([
      expect.objectContaining({ kind: "steer", text: "Check the logs" }),
    ]);
    expect(f.events().findLast((event) => event.type === "message.user")?.data).toMatchObject({
      queued: true,
    });
    expect(f.events().some((event) => event.type === "message.delivery")).toBe(false);
  });

  it("still takes an answer in the form while nothing was sent", async () => {
    const f = setup();
    const waiting = f.call("ask_user", QUICK);
    await until(() => !!f.session.pendingAsk);
    const askId = f.session.pendingAsk;
    expect((await f.post("/answer", { askId, fields: { answer: "PDF" } })).status).toBe(204);
    expect(textOf((await waiting).result)).toMatch(/PDF/);
  });
});
