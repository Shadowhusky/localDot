import { type ConversationEntry, ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  conversationRows,
  conversationStatus,
  conversationTitle,
  groupConversations,
  matchesConversation,
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
  it("reads running, needs you, done, failed and stopped from its latest task", () => {
    const running = entry({ ended: null });
    const waiting = entry({ ended: null });
    const facts = { live: running.sessionId, needsYou: new Set([waiting.sessionId]) };
    expect(conversationStatus(running, facts)).toBe("running");
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
});

describe("search", () => {
  it("matches every word in the title or the first message, in any case and order", () => {
    const trip = entry({ title: "Plan the trip", said: "Somewhere warm in May" });
    expect(matchesConversation(trip, "")).toBe(true);
    expect(matchesConversation(trip, "TRIP plan")).toBe(true);
    expect(matchesConversation(trip, "warm may")).toBe(true);
    expect(matchesConversation(trip, "trip june")).toBe(false);
  });

  it("matches a conversation whose tasks the search index found the words in", () => {
    const older = ulid();
    const trip = entry({ sessions: [ulid(), older] });
    expect(matchesConversation(trip, "boiler", new Set([older]))).toBe(true);
    expect(matchesConversation(trip, "boiler", new Set([ulid()]))).toBe(false);
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
