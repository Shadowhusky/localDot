import { type ConversationEntry, ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { createApi } from "../lib/api.ts";
import {
  arrangeConversations,
  conversationRows,
  conversationStatus,
  conversationTitle,
  groupConversations,
  renameConversation,
  whenLabel,
} from "./conversation-list.ts";

const NOW = new Date(2026, 9, 9, 15, 0);
const at = (days: number, hours = 0) => new Date(2026, 9, 9 - days, 15 - hours, 0).toISOString();
function entry(over: Partial<ConversationEntry> = {}): ConversationEntry {
  const sessionId = over.sessionId ?? ulid();
  return {
    sessionId,
    sessions: [sessionId],
    title: "Plan the trip",
    said: "Plan a trip to Lisbon",
    startedAt: at(0),
    ended: "done",
    ...over,
  };
}
const QUIET = { live: null, needsYou: new Set<string>() };

describe("a conversation's status", () => {
  it("reads working, needs you, done, failed and stopped from its latest task", () => {
    const running = entry({ ended: null });
    const waiting = entry({ ended: null });
    const facts = { live: running.sessionId, needsYou: new Set([waiting.sessionId]) };
    expect(conversationStatus(running, facts)).toBe("working");
    expect(conversationStatus(waiting, facts)).toBe("needs-you");
    expect(conversationStatus(entry({ ended: "done" }), facts)).toBe("done");
    expect(conversationStatus(entry({ ended: "error" }), facts)).toBe("failed");
    expect(conversationStatus(entry({ ended: "stopped" }), facts)).toBe("stopped");
  });

  it("counts the task on the computer that finished its turn as done", () => {
    const resting = entry({ ended: null });
    expect(
      conversationStatus(resting, { live: resting.sessionId, idle: true, needsYou: new Set() }),
    ).toBe("done");
  });

  it("counts a task cut short, with no ending and not running, as stopped", () => {
    expect(conversationStatus(entry({ ended: null }), QUIET)).toBe("stopped");
  });

  it("takes the daemon's word for a conversation under way, and a question waiting over it", () => {
    const live = (state: NonNullable<ConversationEntry["live"]>["state"]) =>
      entry({ ended: null, live: { state, since: at(0), onScreen: false } });
    expect(
      (["working", "waiting-for-computer", "needs-you", "idle", "paused"] as const).map((state) =>
        conversationStatus(live(state), QUIET),
      ),
    ).toEqual(["working", "waiting", "needs-you", "idle", "paused"]);
    const asking = live("working");
    expect(conversationStatus(asking, { live: null, needsYou: new Set([asking.sessionId]) })).toBe(
      "needs-you",
    );
    // The daemon's word wins over the computer's: a second conversation can be at work too.
    expect(conversationStatus(live("idle"), { ...QUIET, live: ulid() })).toBe("idle");
  });
});

describe("a conversation's row", () => {
  it("is under way while the daemon says so or while dot works or waits on the user in it", () => {
    const working = entry({ ended: null });
    const waiting = entry({ ended: "done" });
    const paused = entry({ ended: null, live: { state: "paused", since: at(0), onScreen: false } });
    const facts = { live: working.sessionId, needsYou: new Set([waiting.sessionId]) };
    expect(
      conversationRows([working, waiting, paused, entry()], facts).map((row) => row.active),
    ).toEqual([true, true, true, false]);
  });

  it("dates a conversation under way from its status, and others from their latest task", () => {
    const since = new Date(NOW.getTime() - 120_000).toISOString();
    const [live, ended] = conversationRows(
      [entry({ ended: null, live: { state: "working", since, onScreen: true } }), entry()],
      QUIET,
    );
    expect(live?.since).toBe(since);
    expect(ended?.since).toBe(at(0));
  });

  it("says what dot is doing while it works, from the daemon or from the task on the computer", () => {
    const told = entry({
      ended: null,
      live: { state: "working", since: at(0), onScreen: false, activity: " Opening the site " },
    });
    const running = entry({ ended: null });
    const idle = entry({
      ended: null,
      live: { state: "idle", since: at(0), onScreen: false, activity: "Waiting" },
    });
    const rows = conversationRows([told, running, idle], {
      live: running.sessionId,
      activity: "Typing the address",
      needsYou: new Set(),
    });
    expect(rows.map((row) => row.activity)).toEqual([
      "Opening the site",
      "Typing the address",
      undefined,
    ]);
  });

  it("pins the conversations under way above the rest, each kept newest first", () => {
    const rows = conversationRows(
      [
        entry({ title: "new" }),
        entry({
          title: "live",
          ended: null,
          live: { state: "idle", since: at(0), onScreen: false },
        }),
        entry({ title: "old" }),
        entry({
          title: "older live",
          ended: null,
          live: { state: "paused", since: at(0), onScreen: false },
        }),
        entry({ title: "pinned", pinned: true }),
        entry({
          title: "pinned live",
          pinned: true,
          ended: null,
          live: { state: "working", since: at(0), onScreen: true },
        }),
      ],
      QUIET,
    );
    const { pinned, active, rest } = arrangeConversations(rows);
    expect([pinned, active, rest].map((group) => group.map((row) => row.title))).toEqual([
      ["pinned", "pinned live"],
      ["live", "older live"],
      ["new", "old"],
    ]);
  });
});

describe("renaming", () => {
  it("posts the new name, and an empty one gives the conversation back its own", async () => {
    const posts: unknown[] = [];
    const api = createApi("a".repeat(43), {
      origin: "http://fixture.test",
      fetchImpl: async (url, init) => {
        posts.push([new URL(String(url)).pathname, JSON.parse(String(init?.body))]);
        return new Response(null, { status: 204 });
      },
    });
    const id = ulid();
    await renameConversation(api, id, "  Lisbon trip ");
    await renameConversation(api, id, " ");
    expect(posts).toEqual([
      [`/api/conversations/${id}/title`, { title: "Lisbon trip" }],
      [`/api/conversations/${id}/title`, { title: null }],
    ]);
  });
});

describe("a conversation's title", () => {
  it("is its title, or what was first asked, or says it has none", () => {
    expect(conversationTitle({ title: "Trip", said: "Plan it" })).toBe("Trip");
    expect(conversationTitle({ title: "  ", said: "Plan it" })).toBe("Plan it");
    expect(conversationTitle({ title: null, said: null })).toBe("Untitled conversation");
  });
});

describe("grouping by day", () => {
  it("puts conversations under Today, Yesterday and Earlier, in order, leaving out empty days", () => {
    const rows = conversationRows(
      [
        entry({ title: "a", startedAt: at(0, 1) }),
        entry({ title: "b", startedAt: at(1) }),
        entry({ title: "c", startedAt: at(1, 3) }),
        entry({ title: "d", startedAt: at(9) }),
      ],
      QUIET,
    );
    expect(
      groupConversations(rows, NOW).map((group) => [group.label, group.rows.map((r) => r.title)]),
    ).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["b", "c"]],
      ["Earlier", ["d"]],
    ]);
    expect(groupConversations(rows.slice(3), NOW).map((group) => group.label)).toEqual(["Earlier"]);
  });

  it("lists those pinned, then those under way, first, whatever their day", () => {
    const rows = conversationRows(
      [
        entry({ title: "a", startedAt: at(0, 1) }),
        entry({
          title: "b",
          startedAt: at(9),
          ended: null,
          live: { state: "waiting-for-computer", since: at(0), onScreen: false },
        }),
        entry({ title: "c", startedAt: at(12), pinned: true }),
      ],
      QUIET,
    );
    expect(
      groupConversations(rows, NOW).map((group) => [group.label, group.rows.map((r) => r.title)]),
    ).toEqual([
      ["Pinned", ["c"]],
      ["Active", ["b"]],
      ["Today", ["a"]],
    ]);
  });
});

describe("when", () => {
  it("says minutes and hours today, the time yesterday, then the day", () => {
    expect(whenLabel(new Date(NOW.getTime() - 20_000).toISOString(), NOW)).toBe("Now");
    expect(whenLabel(new Date(NOW.getTime() - 12 * 60_000).toISOString(), NOW)).toBe("12 min");
    expect(whenLabel(at(0, 3), NOW)).toBe("3 h");
    expect(whenLabel(new Date(2026, 9, 8, 18, 5).toISOString(), NOW)).toBe(
      new Date(2026, 9, 8, 18, 5).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    );
    expect(whenLabel(at(3), NOW)).toBe(
      new Date(at(3)).toLocaleDateString([], { weekday: "short" }),
    );
    expect(whenLabel(at(20), NOW)).toBe(
      new Date(at(20)).toLocaleDateString([], { day: "numeric", month: "short" }),
    );
  });
});
