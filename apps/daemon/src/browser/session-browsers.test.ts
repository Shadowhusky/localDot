import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserControlRequest } from "../../../../packages/protocol/src/browser-control.ts";
import { AgentSession } from "../agent/session.ts";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { EventLog } from "../event-log.ts";
import { LiveSessions } from "../gateway/live.ts";
import type { BrowserScope } from "./client.ts";
import { SessionScreens } from "./session-screens.ts";
import { BrowserSlots } from "./slots.ts";
import { BrowserStreams } from "./streams.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0).reverse()) await finish();
});

interface Call {
  op: string;
  sessionId?: string;
  holder?: string;
  url?: string;
}

// A browser per key, each with a browserd of its own that records who asked it what.
function browsers(parent: string) {
  const ready = new Map<string, ReadyBrowser>();
  const calls = new Map<string, Call[]>();
  const holds = new Map<string, Promise<void>>();
  // A browser keeps its cell across restarts, as its record does.
  const cells = new Map<string, string>();
  let port = 5000;
  const browser = {
    start: vi.fn(async (key: string) => {
      const known = ready.get(key);
      if (known) return structuredClone(known);
      const endpoint: ReadyBrowser = {
        parentCellId: parent,
        ...(key === parent ? {} : { slot: key }),
        browserCellId: cells.get(key) ?? ulid(),
        instance: randomUUID(),
        browserd: { baseUrl: `http://127.0.0.1:${port++}`, token: "t".repeat(43) },
        stream: { baseUrl: `http://127.0.0.1:${port++}`, authorization: "fixture" },
      };
      ready.set(key, endpoint);
      cells.set(key, endpoint.browserCellId);
      if (!calls.has(endpoint.browserCellId)) calls.set(endpoint.browserCellId, []);
      return structuredClone(endpoint);
    }),
    endpoints: (key: string) => {
      const known = ready.get(key);
      return known ? structuredClone(known) : undefined;
    },
    stop: vi.fn(async (key: string) => {
      ready.delete(key);
    }),
    remove: vi.fn(async (key: string) => {
      ready.delete(key);
    }),
    get: (key: string) => {
      const known = ready.get(key);
      return known
        ? { id: known.browserCellId, parentCellId: parent, state: "ready" as const }
        : undefined;
    },
    openSlot: vi.fn(),
    keysOf: (id: string) => [id, ...[...ready.keys()].filter((key) => key !== id)],
    slots: () =>
      [...ready.keys()]
        .filter((key) => key !== parent)
        .map((key) => ({ key, parentCellId: parent })),
    subscribe: () => () => {},
  };
  const client = (endpoint: ReadyBrowser) => {
    const log = calls.get(endpoint.browserCellId) ?? [];
    const tab = randomUUID();
    let holder: "user" | "agent" = "user";
    return {
      health: async (scope: BrowserScope) => {
        scope.check();
        return {
          ...endpoint,
          ready: true as const,
          width: 1280 as const,
          height: 800 as const,
          holder,
        };
      },
      tabs: async () => ({ tabs: [{ id: tab, ready: true }] }),
      control: async (request: BrowserControlRequest, scope: BrowserScope) => {
        log.push({
          op: "control",
          holder: request.holder,
          ...("owner" in request ? { sessionId: request.owner.sessionId } : {}),
        });
        await holds.get(endpoint.browserCellId);
        scope.check();
        holder = request.holder === "agent" ? "agent" : "user";
        return {
          browserCellId: endpoint.browserCellId,
          parentCellId: endpoint.parentCellId,
          instance: endpoint.instance,
          requestId: request.requestId,
          revision: request.revision,
          holder,
          reloaded: 0,
          selectionsCleared: true,
        };
      },
      clock: async (_permit: unknown, _tab: string, scope: BrowserScope) => {
        scope.check();
        return { mono: 1 };
      },
      navigate: async (
        permit: { owner: { sessionId: string } },
        _tab: string,
        url: string,
        scope: BrowserScope,
      ) => {
        scope.check();
        log.push({ op: "navigate", sessionId: permit.owner.sessionId, url });
        return { done: true as const };
      },
      close: () => {},
      observe: vi.fn(),
      input: vi.fn(),
      type: vi.fn(),
      settle: vi.fn(),
      lookup: vi.fn(),
      read: vi.fn(),
    };
  };
  return { browser, client, calls, ready, holds };
}

function fixture(extra = 2) {
  const home = mkdtempSync(join(tmpdir(), "session-browsers-"));
  const log = new EventLog(home, { nowMicros: () => 1000 });
  cleanup.push(() => {
    log.close();
    rmSync(home, { recursive: true, force: true });
  });
  const parent = ulid();
  const cell: CellSummary = {
    id: parent,
    state: "ready",
    scale: 2,
    createdAt: "2026-11-09T00:00:00.000Z",
    stream: NO_STREAM,
  };
  const fake = browsers(parent);
  const live = new LiveSessions();
  const slots = new BrowserSlots({
    home,
    browser: fake.browser,
    extra: () => extra,
    computer: () => true,
  });
  const streams = new BrowserStreams({
    parents: { get: () => cell, list: () => [cell], subscribe: () => () => {} },
    browser: fake.browser,
    tickets: { revoke: () => {} },
  });
  cleanup.push(() => streams.dispose());
  const roots = new Map<string, string>();
  const factory = new SessionScreens({
    cells: { get: () => cell, subscribe: () => () => {}, stop: async () => {} },
    browser: fake.browser,
    streams,
    registry: { for: () => undefined },
    recordings: { attach: async () => {}, fence: async () => {} },
    live,
    slots,
    conversationOf: (id) => roots.get(id) ?? id,
    client: fake.client as never,
    now: () => 0,
  });
  // A task of its own conversation, or one that continues `after`'s, live on the computer.
  const task = (title: string, after?: AgentSession) => {
    const id = log.createSession(title);
    if (after) roots.set(id, roots.get(after.id) ?? after.id);
    const session = new AgentSession(id, parent, title, log);
    factory.install(session, cell, false, after?.id);
    const done = Promise.withResolvers<void>();
    live.start(parent, id, () => done.promise);
    cleanup.push(async () => {
      session.stop();
      await session.screensSettled().catch(() => {});
      done.resolve();
    });
    return session;
  };
  const browse = async (session: AgentSession) => {
    const generation = session.beginBrain();
    await session.prepareScreens(generation);
    const lease = session.admit(generation);
    await session.switchScreen("browser", lease);
    lease.finish();
    return generation;
  };
  const navigate = async (session: AgentSession, url: string) => {
    const generation = session.generation!;
    const lease = session.admit(generation);
    const screen = session.screenLease(lease);
    try {
      const access = session.screens!.browserAccess(screen);
      await access.client.navigate(access.permit, access.tabId, url, screen);
    } finally {
      screen.finish();
      lease.finish();
    }
  };
  const shown = (session: AgentSession) => session.screens!.selection.cellId;
  return { ...fake, parent, live, slots, task, browse, navigate, shown, log };
}

describe("a web browser per conversation", () => {
  it("gives conversations browsing at once browsers of their own, with no cross-talk", async () => {
    const f = fixture();
    const a = f.task("first");
    const b = f.task("second");
    const c = f.task("third");
    await Promise.all([f.browse(a), f.browse(b), f.browse(c)]);
    const cells = [a, b, c].map(f.shown);
    expect(new Set(cells).size).toBe(3);
    // The first conversation has the computer's main browser; the others have their own.
    expect(f.slots.keyOf(a.id)).toBe(f.parent);
    expect(f.slots.keyOf(b.id)).not.toBe(f.parent);
    expect(f.slots.keyOf(c.id)).not.toBe(f.slots.keyOf(b.id));

    await Promise.all([
      f.navigate(a, "https://a.example/"),
      f.navigate(b, "https://b.example/"),
      f.navigate(c, "https://c.example/"),
    ]);
    for (const [session, url] of [
      [a, "https://a.example/"],
      [b, "https://b.example/"],
      [c, "https://c.example/"],
    ] as const) {
      const seen = f.calls.get(f.shown(session)) ?? [];
      // Each browser heard only its own task, and saw only its page.
      expect(
        seen.filter((call) => call.sessionId).every((call) => call.sessionId === session.id),
      ).toBe(true);
      expect(seen.filter((call) => call.op === "navigate").map((call) => call.url)).toEqual([url]);
    }
  });

  it("lets a task in its own browser act while another's grant is still settling", async () => {
    const f = fixture();
    const a = f.task("first");
    await f.browse(a);
    const b = f.task("second");
    const c = f.task("third");
    // The main browser's next grant hangs, as on a busy page.
    const stuck = Promise.withResolvers<void>();
    f.holds.set(f.shown(a), stuck.promise);
    const settling = f.browse(c);
    void settling.catch(() => {});
    await f.browse(b);
    await f.navigate(b, "https://b.example/");
    expect(
      f.calls.get(f.shown(b))?.some((call) => call.op === "navigate" && call.sessionId === b.id),
    ).toBe(true);
    stuck.resolve();
    await settling;
  });

  it("keeps a conversation's own browser for its follow-up", async () => {
    const f = fixture();
    const a = f.task("first");
    const b = f.task("second");
    await f.browse(a);
    await f.browse(b);
    const own = f.slots.keyOf(b.id);
    const cell = f.shown(b);
    b.stop();
    await b.screensSettled().catch(() => {});
    const next = f.task("second, again", b);
    await f.browse(next);
    expect(f.slots.keyOf(next.id)).toBe(own);
    expect(f.shown(next)).toBe(cell);
  });

  it("shares the main browser, in a window of its own, when there is no room for another", async () => {
    const f = fixture(1);
    const a = f.task("first");
    const b = f.task("second");
    const c = f.task("third");
    await f.browse(a);
    await f.browse(b);
    await f.browse(c);
    expect(f.slots.keyOf(b.id)).not.toBe(f.parent);
    expect(f.slots.keyOf(c.id)).toBe(f.parent);
    expect(f.shown(c)).toBe(f.shown(a));
  });

  it("parks a conversation browser nobody uses to make room for another", async () => {
    const f = fixture(1);
    const a = f.task("first");
    const b = f.task("second");
    await f.browse(a);
    await f.browse(b);
    const parked = f.slots.keyOf(b.id)!;
    b.stop();
    await b.screensSettled().catch(() => {});
    const c = f.task("third");
    await f.browse(c);
    expect(f.slots.keyOf(c.id)).not.toBe(f.parent);
    expect(f.slots.keyOf(c.id)).not.toBe(parked);
    expect(f.browser.stop).toHaveBeenCalledWith(parked);
    expect(f.browser.endpoints(parked)).toBeUndefined();
  });

  it("takes only the held task's browser when the user takes control", async () => {
    const f = fixture();
    const a = f.task("first");
    const b = f.task("second");
    await f.browse(a);
    await f.browse(b);
    await a.screens!.takeOver();
    const toUser = (cell: string) =>
      (f.calls.get(cell) ?? []).filter((call) => call.op === "control" && call.holder === "user");
    expect(toUser(f.shown(a)).length).toBeGreaterThan(0);
    expect(toUser(f.shown(b))).toEqual([]);
    await f.navigate(b, "https://b.example/still");
    expect(f.calls.get(f.shown(b))?.some((call) => call.url === "https://b.example/still")).toBe(
      true,
    );
  });
});
