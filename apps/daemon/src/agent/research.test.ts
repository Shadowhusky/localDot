import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { isSearchPage, publicUrl, ResearchLog } from "./research.ts";
import { AgentSession } from "./session.ts";

function log(budget = { sources: 3, minutes: 10 }) {
  let now = 1_000_000;
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const research = new ResearchLog(
    budget,
    (type, data) => events.push({ type, data }),
    () => now,
  );
  return {
    research,
    events,
    later: (minutes: number) => {
      now += minutes * 60_000;
    },
  };
}

describe("which pages are sources", () => {
  it("never counts a search engine's results page", () => {
    for (const url of [
      "https://www.google.com/search?q=heat+pumps",
      "https://www.bing.com/search?q=heat",
      "https://html.duckduckgo.com/html/?q=heat",
      "https://search.brave.com/search?q=heat",
      "https://www.baidu.com/s?wd=heat",
    ])
      expect(isSearchPage(url), url).toBe(true);
    for (const url of [
      "https://www.google.com/maps/place/x",
      "https://energysavingtrust.org.uk/search-guide?topic=heat",
      "https://en.wikipedia.org/wiki/Heat_pump",
    ])
      expect(isSearchPage(url), url).toBe(false);
  });
  it("shows a public address without credentials, fragments or private parameters", () => {
    expect(publicUrl("https://user:pw@Example.org/a/?id=4&token=abc&utm=x#top")).toBe(
      "https://example.org/a?id=4&utm=x",
    );
    expect(publicUrl("https://files.example.org/r.pdf?X-Amz-Signature=s&sig=1&v=2")).toBe(
      "https://files.example.org/r.pdf?v=2",
    );
    for (const local of [
      "http://localhost:3000/",
      "http://127.0.0.1/x",
      "https://printer.local/",
      "file:///home/user/a.pdf",
      "about:blank",
    ])
      expect(publicUrl(local), local).toBeUndefined();
  });
});

describe("a research task's sources", () => {
  it("numbers each page once, whatever its fragment or trailing slash", () => {
    const { research, events } = log();
    expect(research.add("https://a.example.org/x/", "A")?.source.n).toBe(1);
    expect(research.add("https://a.example.org/x#part", "A again")).toMatchObject({
      source: { n: 1, title: "A" },
      added: false,
    });
    expect(research.add("https://b.example.org/", "")?.source).toMatchObject({
      n: 2,
      title: "b.example.org",
    });
    expect(research.add("https://b.example.org/", "B")?.source.title).toBe("B");
    expect(events.map((e) => e.type)).toEqual([
      "research.source",
      "research.source",
      "research.source",
    ]);
    expect(events[2]?.data).toEqual({
      n: 2,
      url: "https://b.example.org/",
      title: "B",
      passages: 0,
    });
  });
  it("keeps the source that reaches the budget and refuses the next new one", () => {
    const { research, events } = log();
    for (const path of ["a", "b", "c"]) research.add(`https://example.org/${path}`, path);
    expect(research.stopped).toBe("sources");
    expect(research.sources).toHaveLength(3);
    expect(research.add("https://example.org/d", "d")).toBeUndefined();
    expect(research.add("https://example.org/a", "a")?.added).toBe(false);
    expect(events.filter((e) => e.type === "research.budget")).toEqual([
      { type: "research.budget", data: { sources: 3, minutes: 10, stopped: "sources" } },
    ]);
    expect(research.stopNote()).toContain("(3 sources) is reached");
    expect(research.stopNote()).toContain("write the report now");
  });
  it("stops gathering when the minutes run out, and says so", () => {
    const { research, later } = log({ sources: 20, minutes: 5 });
    research.add("https://example.org/a", "a");
    later(4);
    expect(research.stopped).toBeUndefined();
    expect(research.status()).toBe("1 of about 20 sources, 4 of 5 minutes");
    later(1);
    expect(research.stopped).toBe("time");
    expect(research.stopNote()).toContain("research time (5 minutes) is used up");
  });
  it("wraps up when the user says so, and keeps going with more room when they ask", () => {
    const { research, events, later } = log({ sources: 3, minutes: 5 });
    research.wrapUp();
    expect(research.stopped).toBe("user");
    expect(research.stopNote()).toContain("The user asked you to wrap up.");
    later(7);
    research.more();
    expect(research.stopped).toBeUndefined();
    expect(research.budget).toEqual({ sources: 13, minutes: 17 });
    expect(research.moreNote()).toContain("about 13 sources and 17 minutes");
    expect(events.filter((e) => e.type === "research.budget").map((e) => e.data)).toEqual([
      { sources: 3, minutes: 5, stopped: "user" },
      { sources: 13, minutes: 17 },
    ]);
  });
  it("records each passage once, within bounds, and marks cited sources", () => {
    const { research, events } = log();
    const a = research.add("https://example.org/a", "A")?.source;
    if (!a) throw new Error("no source");
    expect(research.quote(a, ["  The  COP was 3.1  ", "The COP was 3.1", ""])).toBe(1);
    expect(a.passages).toEqual(["The COP was 3.1"]);
    research.quote(
      a,
      Array.from({ length: 20 }, (_, i) => `passage ${i}`),
    );
    expect(a.passages).toHaveLength(12);
    research.cite([1, 9]);
    research.cite([1]);
    expect(a.cited).toBe(true);
    expect(events.filter((e) => e.data.cited)).toHaveLength(1);
  });
});

describe("a follow-up to research", () => {
  it("gets room of its own once the budget was reached", () => {
    const events: string[] = [];
    const session = new AgentSession(ulid(), ulid(), "Compare", {
      append: (_id, event) => {
        events.push(event.type);
        return event as never;
      },
    });
    session.research = new ResearchLog({ sources: 3, minutes: 10 }, (type, data) =>
      session.append(type, data),
    );
    session.research.wrapUp();
    session.post("steer", "Focus on prices");
    expect(session.research.stopped).toBe("user");
    session.post("followup", "Now check warranties too");
    expect(session.research.stopped).toBeUndefined();
    expect(session.research.budget).toEqual({ sources: 13, minutes: 20 });
    session.stop();
  });
});
