import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApprovalCard, type KeydAsk, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../session.ts";
import {
  ConnectionApprovals,
  type ConnectionApprovalsDeps,
  ConnectionCards,
  HOLD_MS,
  MAX_WAITING,
  ONCE_MS,
} from "./connections.ts";
import { type JudgeAction, PurposeGate, type PurposeJudge } from "./purpose.ts";
import { RulesStore } from "./rules.ts";

const CELL = ulid();
let homes: string[] = [];
afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

let next = 0;
const held = (host: string, port: number, source = 40000): KeydAsk => ({
  id: (next++).toString(16).padStart(32, "0"),
  host,
  port,
  source,
  via: "capture",
});

function setup(over: Partial<ConnectionApprovalsDeps> = {}, home?: string) {
  const dir = home ?? mkdtempSync(join(tmpdir(), "ld-connections-"));
  if (!home) homes.push(dir);
  const rules = new RulesStore(dir);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  let session: AgentSession | undefined = new AgentSession(
    ulid(),
    CELL,
    "task",
    {
      append: (_id, e) => {
        events.push(e as never);
        return undefined as never;
      },
    },
    undefined,
    rules,
  );
  const answers: { id: string; decision: string; app?: string }[] = [];
  let now = 1_000_000;
  const deps: ConnectionApprovalsDeps = {
    keyd: {
      asks: async () => [],
      answerAsk: async (_cell, id, decision, app) => {
        answers.push({ id, decision, ...(app ? { app } : {}) });
      },
    },
    task: () => session,
    rules,
    owner: async () => "wechat",
    cells: () => [CELL],
    now: () => now,
    ...over,
  };
  const approvals = new ConnectionApprovals(deps);
  const cards = () =>
    events
      .filter((e) => e.type === "approval.request")
      .map(
        ({ data: { preview, kind: _kind, ...card } }) =>
          ({
            ...card,
            fields: (preview as { fields: unknown }).fields,
          }) as unknown as ApprovalCard,
      );
  const answer = (card: ApprovalCard, decision: "approve" | "deny", always?: string) =>
    session?.connections.answer({
      approvalId: card.approvalId,
      generation: card.generation,
      revision: card.revision,
      decision,
      ...(always ? { always } : {}),
    });
  return {
    approvals,
    answers,
    events,
    cards,
    answer,
    rules,
    dir,
    get session() {
      return session;
    },
    endTask() {
      session?.stop();
      session = undefined;
    },
    later(ms: number) {
      now += ms;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ConnectionCards", () => {
  const make = () => {
    let now = 1_000_000;
    const shown: ApprovalCard[] = [];
    const cards = new ConnectionCards(
      "task",
      (card) => shown.push(card),
      () => {},
      () => now,
    );
    const later = (ms: number) => {
      now += ms;
    };
    return { cards, shown, later };
  };
  const request = (port: number) => ({
    host: "198.51.100.7",
    port,
    why: vi.fn(async () => "An app hasn't used this destination before."),
  });
  const deny = (cards: ConnectionCards) => {
    const card = cards.pending;
    if (!card) throw new Error("no card");
    const { approvalId, generation, revision } = card;
    return cards.answer({ approvalId, generation, revision, decision: "deny" });
  };

  it("works out a card's reason only when it shows, never for a connection let go before then", async () => {
    const f = make();
    const [first, second, third] = [request(6000), request(6001), request(6002)];
    void f.cards.request(first);
    const dropped = f.cards.request(second);
    await settle();
    expect(first.why).toHaveBeenCalledOnce();
    expect(second.why).not.toHaveBeenCalled();
    f.later(HOLD_MS);
    void f.cards.request(third);
    expect(await dropped).toEqual({ allow: false });
    expect(deny(f.cards)).toBe(true);
    await settle();
    expect(second.why).not.toHaveBeenCalled();
    expect(third.why).toHaveBeenCalledOnce();
    expect(f.shown.map((card) => card.title)).toEqual([
      "An app wants to connect to 198.51.100.7 on port 6000",
      "An app wants to connect to 198.51.100.7 on port 6002",
    ]);
  });

  it("keeps a card whose connections keyd let go, so Allow still covers the program's next try", async () => {
    const f = make();
    void f.cards.request(request(6000));
    await settle();
    f.later(HOLD_MS * 2);
    expect(f.cards.pending?.title).toBe("An app wants to connect to 198.51.100.7 on port 6000");
  });

  it("refuses without a card a destination beyond as many as keyd holds", async () => {
    const f = make();
    const waiting = Array.from({ length: MAX_WAITING }, (_, n) => request(6000 + n));
    for (const one of waiting) void f.cards.request(one);
    const extra = request(7000);
    expect(await f.cards.request(extra)).toEqual({ allow: false });
    expect(extra.why).not.toHaveBeenCalled();
    await settle();
    expect(f.shown).toHaveLength(1);
  });

  it("tells dot with its web checks through the proxy how to test an app's own route, at most once a minute", () => {
    const f = make();
    f.cards.checkedThroughProxy("ls ~/.xwechat");
    f.cards.checkedThroughProxy("curl --noproxy '*' -sI https://weixin.qq.com");
    expect(f.cards.takeNotes()).toBeUndefined();
    f.cards.checkedThroughProxy("ping -c 2 x; curl -sI -m 8 https://weixin.qq.com | head -1");
    expect(f.cards.takeNotes()).toContain("test that route with curl --noproxy '*'");
    f.later(30_000);
    f.cards.checkedThroughProxy("wget -q https://example.com");
    expect(f.cards.takeNotes()).toBeUndefined();
    f.later(30_000);
    f.cards.checkedThroughProxy("timeout 10 curl -sI https://www.google.com");
    expect(f.cards.takeNotes()).toContain("test that route with curl --noproxy '*'");
  });
});

describe("connections that wait for the user", () => {
  it("shows one card naming the program and the destination, and lets the connection through once allowed", async () => {
    const f = setup();
    const pending = f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    const [card] = f.cards();
    expect(card).toMatchObject({
      actionClass: "network",
      title: "An app named wechat wants to connect to chat.example.com on port 5222",
      why: "wechat hasn't used this destination before. Apps reach websites on their own; anything else waits for your OK.",
      always: [
        { scope: "task", label: "For this task", destination: "chat.example.com:5222" },
        {
          scope: "destination",
          label: "Always for apps named wechat on chat.example.com · port 5222",
          destination: "chat.example.com:5222",
          app: "wechat",
        },
      ],
    });
    expect(card?.fields).toEqual([
      ["App", "wechat"],
      ["Destination", "chat.example.com · port 5222"],
      ["For the task", "task"],
    ]);
    expect(f.answers).toEqual([]);
    if (!card) throw new Error("no card");
    expect(f.answer(card, "approve")).toBe(true);
    await pending;
    expect(f.answers).toEqual([{ id: expect.any(String), decision: "allow", app: "wechat" }]);
  });

  it("gives the connections one program makes to one place a single card, and Allow once covers its retries for a minute", async () => {
    const f = setup();
    const first = f.approvals.ask(CELL, held("chat.example.com", 5222));
    const second = f.approvals.ask(CELL, held("chat.example.com", 5222, 40001));
    await settle();
    expect(f.cards()).toHaveLength(1);
    const [card] = f.cards();
    if (!card) throw new Error("no card");
    f.answer(card, "approve");
    await Promise.all([first, second]);
    expect(f.answers.map((a) => a.decision)).toEqual(["allow", "allow"]);
    await f.approvals.ask(CELL, held("chat.example.com", 5222));
    expect(f.cards()).toHaveLength(1);
    expect(f.answers.at(-1)?.decision).toBe("allow");
    f.later(ONCE_MS);
    void f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    expect(f.cards()).toHaveLength(2);
  });

  it("keeps a second destination's card queued until the first is answered", async () => {
    const f = setup();
    const a = f.approvals.ask(CELL, held("chat.example.com", 5222));
    const b = f.approvals.ask(CELL, held("files.example.com", 8080));
    await settle();
    expect(f.cards().map((c) => c.title)).toEqual([
      "An app named wechat wants to connect to chat.example.com on port 5222",
    ]);
    const [first] = f.cards();
    if (!first) throw new Error("no card");
    f.answer(first, "deny");
    await a;
    await settle();
    const second = f.cards()[1];
    expect(second?.title).toBe(
      "An app named wechat wants to connect to files.example.com on port 8080",
    );
    if (!second) throw new Error("no second card");
    f.answer(second, "approve");
    await b;
    expect(f.answers.map((x) => x.decision)).toEqual(["deny", "allow"]);
  });

  it("allows a destination for the rest of the task only, without opening any other", async () => {
    const f = setup();
    const pending = f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    const [card] = f.cards();
    if (!card) throw new Error("no card");
    f.answer(card, "approve", "task");
    await pending;
    expect(f.events.find((e) => e.type === "rule.created")?.data).toMatchObject({
      scope: "task",
      actionClass: "network",
      destination: "chat.example.com:5222",
    });
    await f.approvals.ask(CELL, held("chat.example.com", 5222, 40100));
    expect(f.cards()).toHaveLength(1);
    void f.approvals.ask(CELL, held("chat.example.com", 5223));
    await settle();
    expect(f.cards()).toHaveLength(2);
    expect(f.session?.taskAutonomy.revoke("network")).toBeUndefined();
    expect(f.session?.taskAutonomy.revoke("network", "chat.example.com:5222")).toMatchObject({
      destination: "chat.example.com:5222",
    });
    f.later(ONCE_MS);
    void f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    expect(f.cards()).toHaveLength(2);
  });

  it("remembers Always for this app on this destination across a restart, for no other app or place", async () => {
    const f = setup();
    const pending = f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    const [card] = f.cards();
    if (!card) throw new Error("no card");
    f.answer(card, "approve", "destination");
    await pending;
    expect(f.rules.list().rules).toMatchObject([
      {
        actionClass: "network",
        scope: "destination",
        destination: "chat.example.com:5222",
        app: "wechat",
      },
    ]);
    const restarted = setup({}, f.dir);
    restarted.endTask();
    await restarted.approvals.ask(CELL, held("chat.example.com", 5222));
    expect(restarted.answers).toEqual([
      { id: expect.any(String), decision: "allow", app: "wechat" },
    ]);
    await restarted.approvals.ask(CELL, held("chat.example.com", 5223));
    await restarted.approvals.ask(CELL, held("other.example.com", 5222));
    const other = setup({ owner: async () => "curl" }, f.dir);
    other.endTask();
    await other.approvals.ask(CELL, held("chat.example.com", 5222));
    expect([...restarted.answers.slice(1), ...other.answers].map((a) => a.decision)).toEqual([
      "deny",
      "deny",
      "deny",
    ]);
  });

  it("refuses when no task is running, since nobody can say yes", async () => {
    const f = setup();
    f.endTask();
    await f.approvals.ask(CELL, held("chat.example.com", 5222));
    expect(f.answers).toEqual([{ id: expect.any(String), decision: "deny", app: "wechat" }]);
    expect(f.cards()).toEqual([]);
  });

  it("refuses the waiting connections when the task ends", async () => {
    const f = setup();
    const pending = f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    f.endTask();
    await pending;
    expect(f.answers.map((a) => a.decision)).toEqual(["deny"]);
    expect(f.events.find((e) => e.type === "approval.resolve")?.data).toMatchObject({
      decision: "deny",
      note: "The task ended, so the connection stays closed.",
    });
  });

  it("names no program it cannot find, and offers this task or the destination for any app", async () => {
    const f = setup({ owner: async () => undefined });
    void f.approvals.ask(CELL, held("203.0.113.9", 8080));
    await settle();
    void f.approvals.ask(CELL, { ...held("2001:db8::7", 8443), source: undefined });
    await settle();
    const [card] = f.cards();
    expect(card?.title).toBe("An app wants to connect to 203.0.113.9 on port 8080");
    expect(card?.fields[0]).toEqual(["App", "Not known"]);
    expect(card?.always?.map((o) => o.scope)).toEqual(["task", "destination"]);
    expect(card?.always?.at(-1)?.label).toBe("Always for 203.0.113.9 · port 8080");
    if (!card) throw new Error("no card");
    f.answer(card, "deny");
    await settle();
    expect(f.cards()[1]?.always?.at(-1)).toMatchObject({ destination: "[2001:db8::7]:8443" });
  });

  it("refuses answers that are not this card's: take control, another revision, an option it lacks", async () => {
    const f = setup({ owner: async () => undefined });
    void f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    const [card] = f.cards();
    if (!card) throw new Error("no card");
    const base = { approvalId: card.approvalId, generation: card.generation };
    expect(
      f.session?.connections.answer({ ...base, revision: card.revision, decision: "take_control" }),
    ).toBe(false);
    expect(
      f.session?.connections.answer({ ...base, revision: card.revision + 1, decision: "approve" }),
    ).toBe(false);
    expect(f.answer(card, "approve", "app")).toBe(false);
    expect(f.answers).toEqual([]);
  });

  it("gives the purpose check's view of the destination as the card's reason, and still asks", async () => {
    const f = setup();
    const session = f.session;
    if (!session) throw new Error("no session");
    const actions: JudgeAction[] = [];
    const judge: PurposeJudge = {
      name: "jev",
      destinations: async () => [],
      fits: async (_purpose, action) => {
        actions.push(action);
        if (action.destination === "example.org") throw new Error("unavailable");
        return action.destination === "chat.example.com" ? 0.9 : 0.1;
      },
    };
    session.taint.add("files", "notes.txt");
    session.purpose = new PurposeGate({
      taint: session.taint,
      purpose: () => ({ request: ["Message Henry on the chat app"], plan: [] }),
      judge: () => judge,
      trusted: () => false,
    });
    const reasons: (string | undefined)[] = [];
    for (const host of ["chat.example.com", "bad.example.net", "down.example.org"]) {
      const pending = f.approvals.ask(CELL, held(host, 8080));
      await vi.waitFor(() => expect(session.connections.pending).toBeDefined());
      const card = session.connections.pending;
      if (!card) throw new Error("no card");
      reasons.push(card.why);
      f.answer(card, "deny");
      await pending;
    }
    expect(reasons).toEqual([
      "wechat hasn't used this destination before. It looks related to your task.",
      "wechat hasn't used this destination before, and it doesn't look related to your task. dot has read your files in this task.",
      "wechat hasn't used this destination before, and the purpose check couldn't tell whether it fits your task.",
    ]);
    // The judge hears the destination and its port, never the app's own name for itself.
    expect(actions[0]).toEqual({
      kind: "connect",
      destination: "chat.example.com",
      port: 8080,
      method: "connect",
      bytes: 0,
      shape: "connection",
      overlapsPrivateText: false,
      privateData: ["files"],
    });
    expect(JSON.stringify(actions)).not.toContain("wechat");
    expect(f.answers.map((a) => a.decision)).toEqual(["deny", "deny", "deny"]);
  });

  it("tells dot on its next tool result that a connection waits for the user, and what they said", async () => {
    const f = setup();
    const session = f.session;
    if (!session) throw new Error("no session");
    expect(session.connections.takeNotes()).toBeUndefined();
    const pending = f.approvals.ask(CELL, held("chat.example.com", 8080));
    await settle();
    expect(session.connections.takeNotes()).toBe(
      'The app "wechat" is waiting for the user\'s OK to connect to chat.example.com:8080. The user sees a card for it; this is not a network fault. Carry on with other steps, or tell the user it is waiting.',
    );
    expect(session.connections.takeNotes()).toBeUndefined();
    const [card] = f.cards();
    if (!card) throw new Error("no card");
    f.answer(card, "deny");
    await pending;
    expect(session.connections.takeNotes()).toBe(
      "The user didn't allow the app \"wechat\" to connect to chat.example.com:8080. Don't work around it; tell the user what doesn't work without it.",
    );
  });

  it("picks up connections whose event was missed", async () => {
    const asks = [held("chat.example.com", 5222)];
    const f = setup({ keyd: { asks: async () => asks, answerAsk: async () => {} } });
    await f.approvals.sweep();
    await settle();
    expect(f.cards()).toHaveLength(1);
    await f.approvals.sweep();
    await settle();
    expect(f.cards()).toHaveLength(1);
  });
});
