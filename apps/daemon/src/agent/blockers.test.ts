import type { Blocker, LocalDotEvent } from "@localdot/protocol";
import { KEYS_LOCKED_NOTE, KEYS_UNLOCKED_NOTE } from "@localdot/protocol/guidance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolHarness } from "./testing/harness.ts";
import type { ToolDeps } from "./tools/deps.ts";

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const h of fixtures.splice(0)) h.close();
});
function setup(opts: Parameters<typeof toolHarness>[0] = {}) {
  const h = toolHarness(opts);
  fixtures.push(h);
  return { ...h, tools: h.tools as ToolDeps };
}
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("fixture did not reach its boundary");
};
const raises = (events: readonly LocalDotEvent[]) =>
  events.flatMap((event) => (event.type === "blocker.raise" ? [event.data] : []));
const clears = (events: readonly LocalDotEvent[]) =>
  events.flatMap((event) => (event.type === "blocker.clear" ? [event.data] : []));
const said = (body: { content: { text?: string }[] }) =>
  body.content.map((part) => part.text ?? "").join("\n");
const inbox = async (session: ReturnType<typeof setup>["session"], after: number) =>
  (await session.inbox(after, 0)).items.map((item) => item.text);

const KEY: Blocker = { kind: "key", id: "openai", problem: "rejected" };
const APP: Blocker = {
  kind: "app",
  connector: "github",
  name: "GitHub",
  host: "api.githubcopilot.com",
};

describe("a blocker on a task", () => {
  it("raises one card for one thing, however often it fails", () => {
    const { session, events } = setup();
    const first = session.raiseBlocker(KEY);
    const second = session.raiseBlocker({ ...KEY, problem: "reenter" });
    expect(second?.blockerId).toBe(first?.blockerId);
    expect(raises(events())).toHaveLength(1);
    expect(raises(events())[0]).toMatchObject({ blocker: KEY, by: "localdot" });
    expect(session.openBlockers.map((open) => open.blocker)).toEqual([KEY]);
  });

  it("gives separate things separate cards", () => {
    const { session, events } = setup();
    session.raiseBlocker(KEY);
    session.raiseBlocker({ kind: "key", id: "anthropic", problem: "rejected" });
    session.raiseBlocker(APP);
    expect(raises(events())).toHaveLength(3);
  });

  it("tells dot once as it is raised, and wakes it when it clears", async () => {
    const { session, events } = setup();
    const start = session.inboxSequence;
    session.raiseBlocker(KEY);
    session.raiseBlocker(KEY);
    expect(session.inboxSequence).toBe(start + 1);
    expect((await inbox(session, start))[0]).toContain("the key openai");
    const told = session.inboxSequence;
    expect(session.clearBlockers((blocker) => blocker.kind === "key")).toHaveLength(1);
    expect(clears(events())).toEqual([
      { blockerId: raises(events())[0]?.blockerId, outcome: "fixed" },
    ]);
    expect(session.openBlockers).toEqual([]);
    expect(session.inboxSequence).toBe(told + 1);
    const wakes = await session.waitForUser(0);
    expect(wakes).toBe(true);
  });

  it("raises a card with no word to dot when the model has stopped", () => {
    const { session, events } = setup();
    const start = session.inboxSequence;
    session.raiseBlocker({ kind: "model", reason: "model refused" }, { required: true });
    expect(session.inboxSequence).toBe(start);
    expect(raises(events())[0]).toMatchObject({ required: true });
  });

  it("clearing again changes nothing, so every device sees one outcome", () => {
    const { session, events } = setup();
    session.raiseBlocker(KEY);
    session.clearBlockers((blocker) => blocker.kind === "key");
    expect(session.clearBlockers((blocker) => blocker.kind === "key")).toEqual([]);
    expect(clears(events())).toHaveLength(1);
  });

  it("the user's Not now tells dot, and the card doesn't return until they bring it up", async () => {
    const { session, events } = setup();
    const open = session.raiseBlocker(APP);
    const told = session.inboxSequence;
    expect(session.dismissBlocker(open?.blockerId ?? "")).toBe(true);
    expect(clears(events())[0]).toMatchObject({ outcome: "dismissed" });
    expect((await inbox(session, told))[0]).toMatch(/not now to reconnecting GitHub/);
    expect(session.raiseBlocker(APP)).toBeUndefined();
    expect(raises(events())).toHaveLength(1);
    session.post("steer", "Please try GitHub again");
    expect(session.raiseBlocker(APP)).toBeDefined();
    expect(raises(events())).toHaveLength(2);
  });

  it("a card dot can't go on without has no Not now, and overrides an earlier one", () => {
    const { session, events } = setup();
    const open = session.raiseBlocker({ kind: "keys_locked" }, { required: true, tell: false });
    expect(session.dismissBlocker(open?.blockerId ?? "")).toBe(false);
    expect(clears(events())).toEqual([]);
    expect(session.dismissBlocker("01M6R97SHHND5784EZZXSYSBGD")).toBe(false);
  });

  it("a card that becomes required says so, on the same card", () => {
    const { session, events } = setup();
    const open = session.raiseBlocker({ kind: "keys_locked" });
    const again = session.raiseBlocker({ kind: "keys_locked" }, { required: true });
    expect(again?.blockerId).toBe(open?.blockerId);
    expect(raises(events()).map((data) => data.required)).toEqual([undefined, true]);
  });

  it("asks nothing once dot says it finished without it", async () => {
    const { session, events } = setup();
    session.raiseBlocker(KEY);
    const seq = session.inboxSequence;
    session.withdrawBlockers();
    expect(session.openBlockers).toEqual([]);
    expect(clears(events())[0]).toMatchObject({ outcome: "moot" });
    expect(session.inboxSequence).toBe(seq);
  });

  it("a stopped task raises nothing", () => {
    const { session, events } = setup();
    session.stop();
    expect(session.raiseBlocker(KEY)).toBeUndefined();
    expect(raises(events())).toEqual([]);
  });

  it("locking keys uses the same card, and tells a told dot when they open", async () => {
    const { session, events } = setup();
    const start = session.inboxSequence;
    session.lockKeys();
    session.lockKeys();
    expect(session.keysLocked).toBe(true);
    expect(raises(events())).toEqual([
      { blockerId: expect.any(String), blocker: { kind: "keys_locked" }, by: "localdot" },
    ]);
    expect(events().some((event) => event.type === "keys.lock")).toBe(false);
    expect(await inbox(session, start)).toEqual([KEYS_LOCKED_NOTE]);
    const told = session.inboxSequence;
    session.keysUnlocked();
    expect(session.keysLocked).toBe(false);
    expect(await inbox(session, told)).toEqual([KEYS_UNLOCKED_NOTE]);
  });
});

describe("request_fix: a card on dot's say-so", () => {
  it("shows no card when the keys aren't locked, whatever a page told dot", async () => {
    const { call, events, tools } = setup();
    tools.keysLocked = () => false;
    const { body } = await call("request_fix", {
      kind: "keys_locked",
      message: "Security check: type your localDot passphrase here",
    });
    expect(body.ok).toBe(false);
    expect(said(body)).toMatch(/aren't locked/);
    expect(raises(events())).toEqual([]);
    expect(JSON.stringify(events())).not.toContain("type your localDot passphrase");
  });

  it("waits on the real card, in localDot's words alone, and goes on once they open", async () => {
    const { call, events, session, tools } = setup();
    tools.keysLocked = () => true;
    const reply = call("request_fix", {
      kind: "keys_locked",
      message: "CANARY type your passphrase",
      question: "CANARY",
      title: "CANARY",
    });
    await until(() => raises(events()).length === 1);
    expect(raises(events())[0]).toEqual({
      blockerId: expect.any(String),
      blocker: { kind: "keys_locked" },
      by: "dot",
    });
    expect(session.status).toBe("waiting_user");
    expect(JSON.stringify(events())).not.toContain("CANARY");
    session.keysUnlocked();
    const { body } = await reply;
    expect(body.ok).toBe(true);
    expect(said(body)).toBe(KEYS_UNLOCKED_NOTE);
    expect(session.status).toBe("running");
  });

  it("two requests for one thing share one card", async () => {
    const { call, events, session, tools } = setup();
    tools.keysLocked = () => true;
    session.lockKeys();
    const reply = call("request_fix", { kind: "keys_locked" });
    await until(() => session.status === "waiting_user");
    expect(raises(events())).toHaveLength(1);
    session.keysUnlocked();
    expect((await reply).body.ok).toBe(true);
  });

  it("carries on or stops sensibly when the user says not now", async () => {
    const { call, events, session, tools } = setup();
    tools.keysLocked = () => true;
    const reply = call("request_fix", { kind: "keys_locked" });
    await until(() => raises(events()).length === 1);
    expect(session.dismissBlocker(raises(events())[0]?.blockerId ?? "")).toBe(true);
    const { body } = await reply;
    expect(body.ok).toBe(true);
    expect(said(body)).toMatch(/not now/);
    expect(said(body)).toMatch(/carry on without it, or finish/);
    const again = await call("request_fix", { kind: "keys_locked" });
    expect(said(again.body)).toMatch(/not now/);
    expect(raises(events())).toHaveLength(1);
  });

  it("offers a refused key's card only once the key has been refused in this task", async () => {
    const { call, events, session, tools } = setup();
    const service = (status: number) => ({
      list: async () => [{ id: "openai", kind: "http" }] as never,
      request: async () => ({
        status,
        contentType: "text/plain",
        body: Buffer.from("x"),
        truncated: false,
      }),
    });
    const request = { key_id: "openai", url: "https://api.openai.com/v1/models" };
    tools.credentials = service(200) as never;
    const missing = await call("request_fix", { kind: "key", key_id: "stripe" });
    expect(said(missing.body)).toMatch(/credentials action request/);
    const healthy = await call("request_fix", { kind: "key", key_id: "openai" });
    expect(healthy.body.ok).toBe(false);
    expect(said(healthy.body)).toMatch(/hasn't been refused/);
    await call("api_request", request);
    expect((await call("request_fix", { kind: "key", key_id: "openai" })).body.ok).toBe(false);
    expect(raises(events())).toEqual([]);
    tools.credentials = service(401) as never;
    await call("api_request", request);
    expect(raises(events())[0]?.blocker).toEqual({
      kind: "key",
      id: "openai",
      problem: "rejected",
    });
    const reply = call("request_fix", { kind: "key", key_id: "openai" });
    await until(() => session.status === "waiting_user");
    session.clearBlockers((blocker) => blocker.kind === "key");
    expect((await reply).body.ok).toBe(true);
    tools.credentials = service(200) as never;
    await call("api_request", request);
    expect((await call("request_fix", { kind: "key", key_id: "openai" })).body.ok).toBe(false);
  });

  it("says which way a saved key needs fixing, from the key itself", async () => {
    const { call, events, session, tools } = setup();
    tools.credentials = {
      list: async () =>
        [
          { id: "a", kind: "http", reenter: true },
          { id: "b", kind: "http", rebound: true },
        ] as never,
      request: async () => {
        throw new Error("unused");
      },
    };
    for (const [id, count] of [
      ["a", 1],
      ["b", 2],
    ] as const) {
      const reply = call("request_fix", { kind: "key", key_id: id });
      await until(() => raises(events()).length === count);
      session.clearBlockers(() => true);
      await reply;
    }
    expect(raises(events()).map((data) => data.blocker)).toEqual([
      { kind: "key", id: "a", problem: "reenter" },
      { kind: "key", id: "b", problem: "rebound" },
    ]);
  });

  it("offers Connect only for an app whose sign-in really ended", async () => {
    const { call, events, session, tools } = setup();
    const connectors = {
      ended: vi.fn((app: string) =>
        app === "github"
          ? { connector: "github", name: "GitHub", host: "api.githubcopilot.com" }
          : undefined,
      ),
    };
    tools.connectors = connectors as never;
    const fine = await call("request_fix", { kind: "app", app: "linear" });
    expect(said(fine.body)).toMatch(/credentials action connect/);
    expect(raises(events())).toEqual([]);
    const reply = call("request_fix", { kind: "app", app: "github" });
    await until(() => raises(events()).length === 1);
    expect(raises(events())[0]?.blocker).toEqual(APP);
    session.clearBlockers((blocker) => blocker.kind === "app");
    expect((await reply).body.ok).toBe(true);
  });

  it("offers Start or Resume only for a computer that is really off", async () => {
    const { call, events, session, tools } = setup();
    tools.computerDown = () => undefined;
    const on = await call("request_fix", { kind: "computer" });
    expect(said(on.body)).toMatch(/is on/);
    expect(raises(events())).toEqual([]);
    tools.computerDown = () => "paused";
    const reply = call("request_fix", { kind: "computer" });
    await until(() => raises(events()).length === 1);
    expect(raises(events())[0]?.blocker).toEqual({ kind: "computer", state: "paused" });
    session.clearBlockers((blocker) => blocker.kind === "computer");
    expect((await reply).body.ok).toBe(true);
  });

  it("offers to start Docker only while it is really down", async () => {
    const { call, events, session, tools } = setup();
    tools.runtimeDown = async () => false;
    const up = await call("request_fix", { kind: "runtime" });
    expect(said(up.body)).toMatch(/running/);
    expect(raises(events())).toEqual([]);
    tools.runtimeDown = async () => true;
    const reply = call("request_fix", { kind: "runtime" });
    await until(() => raises(events()).length === 1);
    session.clearBlockers((blocker) => blocker.kind === "runtime");
    expect((await reply).body.ok).toBe(true);
  });

  it("gives up waiting after the ask window, leaving the card up", async () => {
    const { call, events, session, tools } = setup({ askTimeoutMs: 20 });
    tools.keysLocked = () => true;
    const { body } = await call("request_fix", { kind: "keys_locked" });
    expect(body.ok).toBe(false);
    expect(said(body)).toMatch(/stays up/);
    expect(session.openBlockers).toHaveLength(1);
    expect(raises(events())).toHaveLength(1);
  });

  it("tells dot when a card it gave up waiting on is fixed after all", async () => {
    const { call, session, tools } = setup({ askTimeoutMs: 20 });
    tools.keysLocked = () => true;
    await call("request_fix", { kind: "keys_locked" });
    const seq = session.inboxSequence;
    session.keysUnlocked();
    expect(await inbox(session, seq)).toEqual([KEYS_UNLOCKED_NOTE]);
  });

  it("tells dot once when a card it is waiting on goes: its call says so", async () => {
    const { call, events, session, tools } = setup();
    tools.keysLocked = () => true;
    session.lockKeys();
    const reply = call("request_fix", { kind: "keys_locked" });
    await until(() => session.status === "waiting_user");
    const seq = session.inboxSequence;
    session.keysUnlocked();
    await reply;
    expect(session.inboxSequence).toBe(seq);
    expect(raises(events())).toHaveLength(1);
  });

  it("takes the user's message as moving on, by the one path every wait shares", async () => {
    const { call, events, session, tools } = setup();
    tools.keysLocked = () => true;
    const reply = call("request_fix", { kind: "keys_locked" });
    await until(() => raises(events()).length === 1);
    expect(session.moveOn("Skip that part and carry on")).toBe(true);
    const { body } = await reply;
    expect(body.ok).toBe(true);
    expect(said(body)).toMatch(/instead of fixing this/);
    expect(session.openBlockers).toEqual([]);
    expect(clears(events())[0]).toMatchObject({ outcome: "moved_on" });
  });

  it("a guest's word doesn't end the wait: only moving on does", async () => {
    const { call, events, session, tools } = setup();
    tools.keysLocked = () => true;
    const reply = call("request_fix", { kind: "keys_locked" });
    await until(() => raises(events()).length === 1);
    session.post("steer", "From a shared link", "guest");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.openBlockers).toHaveLength(1);
    expect(session.status).toBe("waiting_user");
    session.keysUnlocked();
    expect((await reply).body.ok).toBe(true);
  });

  it("stops waiting for a Pause, as a question does", async () => {
    const { call, events, session, tools } = setup();
    tools.keysLocked = () => true;
    const reply = call("request_fix", { kind: "keys_locked" });
    await until(() => raises(events()).length === 1);
    session.requestSafetyPause("01M6R97SHHND5784EZZXSYSBGD");
    const { body } = await reply;
    expect(body.pause).toBe(true);
  });
});

describe("ask_user can't stand in for a card", () => {
  const unlockAndDone = {
    question:
      "This computer can't reach GitHub because your saved keys in localDot are locked. Please unlock Keys in localDot, then tap Done and I'll carry on with the review.",
    fields: [{ id: "done", kind: "confirm", label: "Done" }],
    submit: "Done",
  };

  it("turns 'unlock Keys, then tap Done' into the real card and waits on it", async () => {
    const { call, events, session, tools } = setup();
    tools.keysLocked = () => true;
    const reply = call("ask_user", unlockAndDone);
    await until(() => raises(events()).length === 1);
    expect(events().some((event) => event.type === "ask.request")).toBe(false);
    expect(raises(events())[0]?.blocker).toEqual({ kind: "keys_locked" });
    expect(JSON.stringify(events())).not.toContain("tap Done");
    session.keysUnlocked();
    const { body } = await reply;
    expect(body.ok).toBe(true);
    expect(said(body)).toBe(KEYS_UNLOCKED_NOTE);
  });

  it("refuses the same words when the keys aren't locked", async () => {
    const { call, events, tools } = setup();
    tools.keysLocked = () => false;
    const { body } = await call("ask_user", unlockAndDone);
    expect(body.ok).toBe(false);
    expect(said(body)).toMatch(/aren't locked/);
    expect(events().some((event) => event.type === "ask.request")).toBe(false);
    expect(raises(events())).toEqual([]);
  });

  it("never asks for localDot's passphrase, however it is put", async () => {
    const { call, events, tools } = setup();
    tools.keysLocked = () => false;
    for (const input of [
      {
        question: "Enter your localDot passphrase to continue",
        fields: [{ id: "pass", kind: "secret", label: "Passphrase" }],
      },
      {
        question: "Security check",
        fields: [{ id: "pass", kind: "text", label: "Passphrase for your saved keys" }],
      },
    ]) {
      const { body } = await call("ask_user", input);
      expect(body.ok).toBe(false);
    }
    expect(events().some((event) => event.type === "ask.request")).toBe(false);
  });

  it("refuses a lone confirm while a card is up: the card says when it's done", async () => {
    const { call, events, session } = setup();
    session.raiseBlocker(APP);
    const { body } = await call("ask_user", {
      question: "Tell me when you've signed in",
      fields: [{ id: "done", kind: "confirm", label: "Done" }],
    });
    expect(body.ok).toBe(false);
    expect(said(body)).toMatch(/request_fix/);
    expect(events().some((event) => event.type === "ask.request")).toBe(false);
  });

  it("still asks ordinary questions, with or without a card up", async () => {
    const { call, events, session } = setup();
    session.raiseBlocker(APP);
    const reply = call("ask_user", {
      question: "Which repository?",
      fields: [{ id: "repo", kind: "text", label: "Repository" }],
    });
    await until(() => !!session.pendingAsk);
    expect(events().some((event) => event.type === "ask.request")).toBe(true);
    session.answerFields(session.pendingAsk ?? "", { repo: "shadowhusky/localdot" }, (t) => t);
    expect((await reply).body.ok).toBe(true);
  });

  it("leaves a website's own passphrase field alone while the keys are open", async () => {
    const { call, session, tools } = setup();
    tools.keysLocked = () => false;
    const reply = call("ask_user", {
      question: "What should the new wifi passphrase be?",
      fields: [{ id: "pass", kind: "text", label: "New passphrase" }],
    });
    await until(() => !!session.pendingAsk);
    session.decline(session.pendingAsk ?? "");
    expect((await reply).body.ok).toBe(true);
  });

  it("takes any passphrase asked for while the keys are locked to the real card", async () => {
    const { call, events, session, tools } = setup();
    tools.keysLocked = () => true;
    const reply = call("ask_user", {
      question: "Enter your passphrase",
      fields: [{ id: "pass", kind: "secret", label: "Passphrase" }],
    });
    await until(() => raises(events()).length === 1);
    expect(events().some((event) => event.type === "ask.request")).toBe(false);
    expect(raises(events())[0]?.blocker).toEqual({ kind: "keys_locked" });
    session.keysUnlocked();
    expect((await reply).body.ok).toBe(true);
  });

  it("leaves other people's keys out of it", async () => {
    const { call, session, tools } = setup();
    tools.keysLocked = () => false;
    const reply = call("ask_user", {
      question: "Did you leave your keys locked in the car?",
      fields: [{ id: "where", kind: "text", label: "Where are they" }],
    });
    await until(() => !!session.pendingAsk);
    session.decline(session.pendingAsk ?? "");
    expect((await reply).body.ok).toBe(true);
  });

  it("lets the brain's own Keep going guard through", async () => {
    const { call, session } = setup();
    session.raiseBlocker(APP);
    const reply = call("ask_user", {
      question: "Keep going?",
      fields: [{ id: "keep_going", kind: "confirm", label: "Keep going" }],
    });
    await until(() => !!session.pendingAsk);
    session.decline(session.pendingAsk ?? "");
    expect((await reply).body.ok).toBe(true);
  });
});

describe("failures localDot recognises by itself", () => {
  const service = (reply: {
    status: number;
    keydReason?: string;
    keydSecret?: string;
    throws?: Error;
  }) => ({
    list: async () => [{ id: "github", kind: "http" }] as never,
    request: async () => {
      if (reply.throws) throw reply.throws;
      return {
        status: reply.status,
        contentType: "text/plain",
        body: Buffer.from("keyd"),
        truncated: false,
        ...(reply.keydReason ? { keydReason: reply.keydReason } : {}),
        ...(reply.keydSecret ? { keydSecret: reply.keydSecret } : {}),
      };
    },
  });
  const request = { key_id: "github", url: "https://api.github.com/user" };

  it("a service call refused for locked keys raises the unlock card", async () => {
    const { call, events, session, tools } = setup();
    tools.keysLocked = () => true;
    tools.credentials = service({ status: 423, keydReason: "vault-locked" });
    await call("api_request", request);
    expect(raises(events()).map((data) => data.blocker)).toEqual([{ kind: "keys_locked" }]);
    expect(session.keysLocked).toBe(true);
  });

  it("a service can't summon the card by answering 423 itself", async () => {
    const { call, events, tools } = setup();
    tools.keysLocked = () => false;
    tools.credentials = service({ status: 423, keydReason: "vault-locked" });
    await call("api_request", request);
    expect(raises(events())).toEqual([]);
  });

  it("a key a service answers 401 to raises its replace card", async () => {
    const { call, events, tools } = setup();
    tools.credentials = service({ status: 401 });
    await call("api_request", request);
    expect(raises(events()).map((data) => data.blocker)).toEqual([
      { kind: "key", id: "github", problem: "rejected" },
    ]);
  });

  it("the same key answering takes its card down", async () => {
    const { call, session, tools } = setup();
    tools.credentials = service({ status: 401 });
    await call("api_request", request);
    expect(session.openBlockers).toHaveLength(1);
    tools.credentials = service({ status: 200 });
    await call("api_request", request);
    expect(session.openBlockers).toEqual([]);
  });

  it("any other refusal is the task's to read", async () => {
    const { call, events, tools } = setup();
    for (const status of [200, 403, 404, 429, 500]) {
      tools.credentials = service({ status });
      await call("api_request", request);
    }
    expect(raises(events())).toEqual([]);
  });

  it("a key keyd can't use raises its card, by what is wrong with it", async () => {
    const { ServiceKeyProblem } = await import("../keyd/service-keys.ts");
    const { call, events, tools } = setup();
    tools.credentials = service({
      status: 0,
      throws: new ServiceKeyProblem("github", "reenter"),
    });
    const { body } = await call("api_request", request);
    expect(body.ok).toBe(false);
    expect(raises(events()).map((data) => data.blocker)).toEqual([
      { kind: "key", id: "github", problem: "reenter" },
    ]);
  });

  it("doesn't take a call that went through for the user's fix", async () => {
    const { call, events, session, tools } = setup();
    const start = session.inboxSequence;
    const service = (status: number) => ({
      list: async () => [{ id: "github", kind: "http" }] as never,
      request: async () => ({
        status,
        contentType: "text/plain",
        body: Buffer.from("x"),
        truncated: false,
      }),
    });
    const request = { key_id: "github", url: "https://api.github.com/user" };
    tools.credentials = service(401) as never;
    await call("api_request", request);
    tools.credentials = service(200) as never;
    await call("api_request", request);
    const heard = (await session.inbox(start, 0)).items.map((item) => item.text).join("\n");
    expect(heard).not.toContain("the user entered");
    expect(clears(events()).map((data) => data.outcome)).toEqual(["worked"]);
    expect(session.openBlockers).toEqual([]);
  });

  describe("a connected app's tool", () => {
    const entry = {
      connectorId: "github",
      app: "GitHub",
      tool: "search",
      exposed: "github__search",
      host: "api.githubcopilot.com",
    };
    const call = async (
      h: ReturnType<typeof setup>,
      outcome: { ok: boolean; text: string; signInEnded?: true },
    ) => {
      const { connectorTool } = await import("./tools/connector.ts");
      h.tools.connectors = {
        call: async () => outcome,
        ended: () => ({ connector: "github", name: "GitHub", host: "api.githubcopilot.com" }),
      } as never;
      const generation = h.session.generation;
      if (!generation) throw new Error("fixture has no brain");
      const lease = h.session.admit(generation);
      try {
        return await connectorTool(
          h.tools,
          {
            session: h.session,
            generation,
            lease,
            check: () => lease.check(),
            callId: "c",
            step: "step",
            redact: (text: string) => text,
            signal: lease.signal,
            permit: { consume: () => true },
          } as never,
          entry as never,
          {},
          undefined,
        );
      } finally {
        lease.finish?.();
      }
    };

    it("raises Connect when the app says its sign-in ended", async () => {
      const h = setup();
      await call(h, { ok: false, text: "Its sign-in has ended.", signInEnded: true });
      expect(raises(h.events()).map((data) => data.blocker)).toEqual([APP]);
    });

    it("raises Unlock when a call fails while the keys are locked", async () => {
      const h = setup();
      h.tools.keysLocked = () => true;
      await call(h, { ok: false, text: "The app refused." });
      expect(raises(h.events()).map((data) => data.blocker)).toEqual([{ kind: "keys_locked" }]);
    });

    it("takes the app's card down when a call to it works again", async () => {
      const h = setup();
      await call(h, { ok: false, text: "Its sign-in has ended.", signInEnded: true });
      expect(h.session.openBlockers).toHaveLength(1);
      await call(h, { ok: true, text: "Done" });
      expect(h.session.openBlockers).toEqual([]);
    });

    it("raises nothing for the app's own error, or a call that worked", async () => {
      const h = setup();
      h.tools.keysLocked = () => false;
      await call(h, { ok: false, text: "No such issue." });
      await call(h, { ok: true, text: "Done" });
      expect(raises(h.events())).toEqual([]);
    });
  });
});
