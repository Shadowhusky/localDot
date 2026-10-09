import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApprovalCard, type KeydAsk, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../session.ts";
import { ConnectionApprovals, type ConnectionApprovalsDeps, ONCE_MS } from "./connections.ts";
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

describe("connections that wait for the user", () => {
  it("shows one card naming the program and the destination, and lets the connection through once allowed", async () => {
    const f = setup();
    const pending = f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    const [card] = f.cards();
    expect(card).toMatchObject({
      actionClass: "network",
      title: "wechat wants to connect to chat.example.com:5222",
      always: [
        { scope: "task", label: "For this task", destination: "chat.example.com:5222" },
        { scope: "app", label: "Always for wechat", app: "wechat" },
        {
          scope: "destination",
          label: "Always for chat.example.com:5222",
          destination: "chat.example.com:5222",
        },
      ],
    });
    expect(card?.fields).toEqual([
      ["Program", "wechat"],
      ["Destination", "chat.example.com:5222"],
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
      "wechat wants to connect to chat.example.com:5222",
    ]);
    const [first] = f.cards();
    if (!first) throw new Error("no card");
    f.answer(first, "deny");
    await a;
    await settle();
    const second = f.cards()[1];
    expect(second?.title).toBe("wechat wants to connect to files.example.com:8080");
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
    f.session?.taskAutonomy.revoke("network");
    f.later(ONCE_MS);
    void f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    expect(f.cards()).toHaveLength(2);
  });

  it("remembers Always for a program or a destination across a restart of the daemon", async () => {
    const f = setup();
    const pending = f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    const [card] = f.cards();
    if (!card) throw new Error("no card");
    f.answer(card, "approve", "destination");
    await pending;
    expect(f.rules.list().rules).toMatchObject([
      { actionClass: "network", scope: "destination", destination: "chat.example.com:5222" },
    ]);
    const restarted = setup({ owner: async () => "another-program" }, f.dir);
    restarted.endTask();
    await restarted.approvals.ask(CELL, held("chat.example.com", 5222));
    expect(restarted.answers).toEqual([
      { id: expect.any(String), decision: "allow", app: "another-program" },
    ]);
    await restarted.approvals.ask(CELL, held("other.example.com", 5222));
    expect(restarted.answers.at(-1)?.decision).toBe("deny");
  });

  it("lets an Always for the program through to any destination of that program only", async () => {
    const f = setup();
    const pending = f.approvals.ask(CELL, held("chat.example.com", 5222));
    await settle();
    const [card] = f.cards();
    if (!card) throw new Error("no card");
    f.answer(card, "approve", "app");
    await pending;
    await f.approvals.ask(CELL, held("elsewhere.example.net", 443));
    expect(f.answers.at(-1)).toMatchObject({ decision: "allow", app: "wechat" });
    const other = setup({ owner: async () => "curl" }, f.dir);
    void other.approvals.ask(CELL, held("elsewhere.example.net", 443));
    await settle();
    expect(other.cards()).toHaveLength(1);
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

  it("names no program it cannot find, and offers no Always for one", async () => {
    const f = setup({ owner: async () => undefined });
    void f.approvals.ask(CELL, held("203.0.113.9", 8080));
    await settle();
    void f.approvals.ask(CELL, { ...held("2001:db8::7", 8443), source: undefined });
    await settle();
    const [card] = f.cards();
    expect(card?.title).toBe("A program wants to connect to 203.0.113.9:8080");
    expect(card?.always?.map((o) => o.scope)).toEqual(["task", "destination"]);
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

  it("lets the purpose judge decide a destination before anyone is asked", async () => {
    const judge = vi.fn(async ({ host }: { host: string }) =>
      host === "chat.example.com"
        ? ("allow" as const)
        : host === "bad.example.com"
          ? ("deny" as const)
          : undefined,
    );
    const f = setup({ judge });
    await f.approvals.ask(CELL, held("chat.example.com", 5222));
    await f.approvals.ask(CELL, held("bad.example.com", 5222));
    expect(f.answers.map((a) => a.decision)).toEqual(["allow", "deny"]);
    expect(f.cards()).toEqual([]);
    expect(judge).toHaveBeenCalledWith(
      expect.objectContaining({
        cellId: CELL,
        app: "wechat",
        host: "chat.example.com",
        port: 5222,
      }),
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
