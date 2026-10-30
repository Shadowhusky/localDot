import { type ConversationEntry, type SearchHit, ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { conversationRows } from "./conversation-list.ts";
import { searchConversations, searchWords } from "./conversation-search.ts";

const QUIET = { live: null, needsYou: new Set<string>() };
function rows(...entries: Partial<ConversationEntry>[]) {
  return conversationRows(
    entries.map((over) => {
      const sessionId = over.sessionId ?? ulid();
      return {
        sessionId,
        sessions: [sessionId],
        title: null,
        said: null,
        startedAt: "2026-10-30T09:00:00.000Z",
        ended: "done",
        ...over,
      };
    }),
    QUIET,
  );
}
const titles = (query: string, list: ReturnType<typeof rows>, found?: Map<string, SearchHit>) =>
  searchConversations(list, query, found).map((match) => match.row.title);
const hit = (sessionId: string, snippet: string): SearchHit => ({
  sessionId,
  title: null,
  startedAt: null,
  kind: "assistant",
  at: "2026-10-30T09:00:00.000Z",
  snippet,
});

describe("searching conversations", () => {
  it("finds every word at the start of a word in the title, whatever its case and accents", () => {
    const list = rows(
      { title: "Plan the Lisbon trip" },
      { title: "Café near the office" },
      { title: "Zürich hotels" },
      { title: "Draw a dog" },
    );
    expect(titles("lis", list)).toEqual(["Plan the Lisbon trip"]);
    expect(titles("TRIP plan", list)).toEqual(["Plan the Lisbon trip"]);
    expect(titles("cafe", list)).toEqual(["Café near the office"]);
    expect(titles("zurich", list)).toEqual(["Zürich hotels"]);
    expect(titles("lisbon dog", list)).toEqual([]);
    expect(titles("  ", list)).toEqual([]);
  });

  it("marks what matched in the title, in the title's own letters", () => {
    const [match] = searchConversations(rows({ title: "Café near the office" }), "CAFE off");
    expect(match?.title).toBe("Café near the office");
    expect(match?.snippet).toBeUndefined();
  });

  it("forgives a small typo in a longer word, but not in its first letter", () => {
    const list = rows({ title: "Plan the Lisbon trip" }, { title: "Reply to the landlord" });
    expect(titles("lisbn", list)).toEqual(["Plan the Lisbon trip"]);
    expect(titles("tirp", list)).toEqual(["Plan the Lisbon trip"]);
    expect(titles("landlrod", list)).toEqual(["Reply to the landlord"]);
    expect(titles("kisbon", list)).toEqual([]);
    expect(titles("tro", list)).toEqual([]);
  });

  it("ranks the title's start, then a word's start, then inside a word, then a typo", () => {
    const list = rows(
      { title: "Weekend in Porto" },
      { title: "Passport renewal" },
      { title: "Export the report" },
      { title: "Porto wine tour" },
    );
    expect(titles("port", list)).toEqual([
      "Porto wine tour",
      "Weekend in Porto",
      "Passport renewal",
      "Export the report",
    ]);
  });

  it("then finds the words in the first message, and shows it", () => {
    const list = rows(
      { title: "Weekend away", said: "Somewhere warm in May, maybe Lisbon" },
      { title: "Lisbon flights" },
    );
    const found = searchConversations(list, "lisbon");
    expect(found.map((match) => match.row.title)).toEqual(["Lisbon flights", "Weekend away"]);
    expect(found[1]?.snippet).toBe("Somewhere warm in May, maybe Lisbon");
  });

  it("then those the search index found in any of their tasks, as it ranks them", () => {
    const older = ulid();
    const list = rows(
      { title: "Fix the boiler", sessions: [ulid()] },
      { title: "Plan the trip", sessions: [ulid(), older] },
      { title: "Draw a dog" },
      { title: "Book the hotel" },
    );
    const [, trip, dog] = list;
    const found = new Map([
      [dog?.entry.sessionId ?? "", hit(dog?.entry.sessionId ?? "", "a boiler suit")],
      [older, hit(older, "the boiler at the flat")],
    ]);
    const matches = searchConversations(list, "boiler", found);
    expect(matches.map((match) => match.row.title)).toEqual([
      "Fix the boiler",
      "Draw a dog",
      "Plan the trip",
    ]);
    expect(matches[2]).toMatchObject({ row: trip, snippet: "the boiler at the flat" });
  });

  it("keeps up with hundreds of conversations", () => {
    const words = ["plan", "trip", "invoice", "landlord", "garden", "boiler", "flights", "report"];
    const list = rows(
      ...Array.from({ length: 600 }, (_, n) => ({
        title: `${words[n % 8]} ${words[(n * 3) % 8]} number ${n}`,
        said: `Please look at the ${words[(n * 5) % 8]} for me`,
      })),
    );
    searchConversations(list, "warm up");
    const started = performance.now();
    for (const query of ["l", "la", "lan", "land", "landl", "landlo", "landlrd", "landlord rep"])
      searchConversations(list, query);
    expect((performance.now() - started) / 8).toBeLessThan(25);
    expect(searchConversations(list, "landlord").length).toBeGreaterThan(100);
  });

  it("reads at most eight words, letters and digits only", () => {
    expect(searchWords("“Lisbon”, trip! (2026) a b c d e f g")).toEqual([
      "lisbon",
      "trip",
      "2026",
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});
