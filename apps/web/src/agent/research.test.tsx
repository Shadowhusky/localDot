// @vitest-environment jsdom
import { LocalDotEvent } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { type AgentResearch, emptyAgentModel } from "./model.ts";
import { ResearchSources } from "./ResearchSources.tsx";
import { projectAgentEvent } from "./reducer.ts";
import { looksLikeResearch, researchMeta, researchUsed, sourceMeta } from "./research.ts";
import { deliverText } from "./write-api.ts";

const sessionId = "01JXYZ0000000000000000SESS";
const cellId = "01JXYZ0000000000000000CE11";
const ev = (seq: number, type: string, data: unknown) =>
  LocalDotEvent.parse({
    v: 1,
    id: String(seq).padStart(26, "0"),
    seq,
    t: seq * 1_000_000,
    agent: "main",
    type,
    data,
  });
const source = (n: number, extra: object = {}) => ({
  n,
  url: `https://www.site${n}.example.org/page`,
  title: `Page ${n}`,
  passages: 0,
  ...extra,
});
const research = (over: Partial<AgentResearch> = {}): AgentResearch => ({
  startMs: 0,
  budget: { sources: 20, minutes: 15 },
  sources: [],
  ...over,
});
afterEach(cleanup);

describe("a research task's projection", () => {
  it("starts with the budget, keeps sources in number order and notes why gathering stopped", () => {
    const model = [
      ev(0, "session.start", {
        screen: { w: 1280, h: 800, scale: 1 },
        os: "linux",
        research: { sources: 20, minutes: 15 },
      }),
      ev(1, "research.source", source(2)),
      ev(2, "research.source", source(1)),
      ev(3, "research.source", source(2, { passages: 2, cited: true })),
      ev(4, "research.budget", { sources: 20, minutes: 15, stopped: "user" }),
    ].reduce(projectAgentEvent, emptyAgentModel());
    expect(model.research).toEqual({
      startMs: 0,
      budget: { sources: 20, minutes: 15 },
      stopped: "user",
      sources: [source(1), source(2, { passages: 2, cited: true })],
    });
    const more = projectAgentEvent(model, ev(5, "research.budget", { sources: 30, minutes: 25 }));
    expect(more.research?.stopped).toBeUndefined();
    expect(more.research?.budget).toEqual({ sources: 30, minutes: 25 });
  });
  it("ignores research events for a task that is not research", () => {
    const model = [
      ev(0, "session.start", { screen: { w: 1280, h: 800, scale: 1 }, os: "linux" }),
      ev(1, "research.source", source(1)),
    ].reduce(projectAgentEvent, emptyAgentModel());
    expect(model.research).toBeNull();
  });
});

describe("research words", () => {
  it("count the budget while dot reads, then what it read and cited", () => {
    const reading = research({ sources: [source(1), source(2)] });
    expect(researchMeta(reading, 64_000)).toBe("2 of 20 · 1:04 of 15:00");
    expect(researchUsed(reading, 0)).toBe(0.1);
    expect(researchUsed(reading, 450_000)).toBe(0.5);
    expect(researchMeta({ ...reading, stopped: "time" }, 0)).toBe("2 sources · writing the report");
    const written = research({ sources: [source(1, { cited: true }), source(2)] });
    expect(researchMeta(written, 0)).toBe("2 read · 1 cited");
    expect(researchUsed(written, 0)).toBe(1);
    expect(researchMeta(research({ budget: { sources: 30, minutes: 90 } }), 0)).toBe(
      "0 of 30 · 0:00 of 1:30:00",
    );
  });
  it("describe a source by its site, its passages and whether the report cites it", () => {
    expect(sourceMeta(source(3))).toBe("site3.example.org");
    expect(sourceMeta(source(3, { passages: 1, cited: true }))).toBe(
      "site3.example.org · 1 passage · Cited",
    );
  });
  it("suggest research for questions that need many sources, never for actions", () => {
    for (const text of [
      "Compare the best heat pumps for cold climates and cite sources",
      "What is the evidence that intermittent fasting works?",
      "Research the market size for home batteries in the UK",
      "对比一下几款电动车的续航和价格",
      "Which laptops are best for video editing in 2026? Compare prices",
    ])
      expect(looksLikeResearch(text), text).toBe(true);
    for (const text of [
      "Send Anna the research report",
      "Book a table for two at 8",
      "hi",
      "Open the spreadsheet on my desktop",
      "Draw a dog",
    ])
      expect(looksLikeResearch(text), text).toBe(false);
  });
});

describe("research sources in Activity", () => {
  const api = () => {
    const calls: { path: string; body: unknown }[] = [];
    return {
      calls,
      api: createApi("fixture", {
        origin: "http://127.0.0.1:4790",
        fetchImpl: async (url, init) => {
          calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
          return new Response(null, { status: 204 });
        },
      }),
    };
  };
  it("lists the newest sources as links that open the page, with the rest one tap away", () => {
    const sources = Array.from({ length: 8 }, (_, i) => source(i + 1));
    const { api: client } = api();
    render(
      <ResearchSources
        research={research({ sources })}
        nowMs={60_000}
        working
        api={client}
        sessionId={sessionId}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "4Page 4site4.example.org",
      "5Page 5site5.example.org",
      "6Page 6site6.example.org",
      "7Page 7site7.example.org",
      "8Page 8site8.example.org",
    ]);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Show all 8" }));
    expect(screen.getAllByRole("link")).toHaveLength(8);
    expect(screen.getByText("8 of 20 · 1:00 of 15:00")).toBeTruthy();
  });
  it("wraps up on the user's word while dot reads, and keeps going once it stopped", async () => {
    const { api: client, calls } = api();
    const view = render(
      <ResearchSources research={research()} working api={client} sessionId={sessionId} />,
    );
    expect(screen.getByText("Sources appear here as dot reads them.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Wrap up now" })));
    view.rerender(
      <ResearchSources
        research={research({ stopped: "user" })}
        working
        api={client}
        sessionId={sessionId}
      />,
    );
    expect(screen.getByText("dot is wrapping up with what it has.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Keep going" })));
    expect(calls).toEqual([
      { path: `/api/agent/sessions/${sessionId}/research`, body: { change: "wrap_up" } },
      { path: `/api/agent/sessions/${sessionId}/research`, body: { change: "more" } },
    ]);
  });
  it("offers no budget choice once dot has stopped working or in a replay", () => {
    const { api: client } = api();
    render(
      <ResearchSources research={research()} working={false} api={client} sessionId={sessionId} />,
    );
    expect(screen.queryByRole("button", { name: "Wrap up now" })).toBeNull();
  });
});

describe("starting research", () => {
  it("asks the daemon for a research task, and never for a message or a revision", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ sessionId: "01JXYZ00000000000000000NEW" }, { status: 202 }),
    );
    const client = createApi("fixture", { origin: "http://127.0.0.1:4790", fetchImpl });
    await deliverText(client, {
      cellId,
      sessionId: null,
      mode: "new",
      text: "Compare heat pumps",
      research: true,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ task: "Compare heat pumps", mode: "research" });
    await expect(
      deliverText(client, { cellId, sessionId, mode: "steer", text: "x", research: true }),
    ).rejects.toMatchObject({ uncertain: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
