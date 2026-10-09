// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { Highlight } from "./Highlight.tsx";
import { SEARCH_DEBOUNCE_MS, searchable, useTaskSearch } from "./search-api.ts";
import { shownCards } from "./TasksLibrary.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const TASK = "01JXYZ0000000000000000TASK";
const hit = (sessionId: string | null, snippet: string) => ({
  sessionId,
  title: sessionId ? "Plan the Lisbon trip" : null,
  startedAt: null,
  kind: "assistant" as const,
  at: "2026-10-08T09:00:00.000Z",
  snippet,
});

describe("search in the Tasks library", () => {
  it("searches once typing pauses, drops the earlier request and keeps the last answer meanwhile", async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const q = new URL(String(url)).searchParams.get("q") ?? "";
      asked.push(q);
      expect(init?.signal).toBeTruthy();
      return Response.json({
        hits: [hit(TASK, "Travel insurance was optional"), hit(null, "a note")],
        complete: true,
        mode: "fts",
      });
    });
    const api = createApi("a".repeat(43), { fetchImpl, origin: "http://fixture.test" });
    const { result, rerender } = renderHook(({ q }) => useTaskSearch(api, q), {
      initialProps: { q: "i" },
    });
    expect(result.current.pending).toBe(false);
    rerender({ q: "ins" });
    rerender({ q: "insur" });
    expect(result.current.pending).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(asked).toEqual(["insur"]);
    expect(result.current.pending).toBe(false);
    expect(result.current.tasks.get(TASK)?.snippet).toContain("insurance");
    expect(result.current.notes).toHaveLength(1);
    rerender({ q: "insurance" });
    expect(result.current).toMatchObject({ pending: true });
    expect(result.current.tasks.has(TASK)).toBe(true);
  });
  it("needs two letters, or one CJK character", () => {
    expect(searchable("a")).toBe(false);
    expect(searchable(" ab ")).toBe(true);
    expect(searchable("保")).toBe(true);
  });
  it("shows a recording its title or its words match", () => {
    const card = (id: string, title: string) =>
      ({ id, title, verdict: "done" }) as Parameters<typeof shownCards>[0][number];
    const cards = [
      card(TASK, "Plan the Lisbon trip"),
      card("01JXYZ0000000000000000OTHR", "Tidy up"),
    ];
    const matches = { tasks: new Map([[TASK, hit(TASK, "x")]]), notes: [], pending: false };
    expect(shownCards(cards, "insurance").map((c) => c.id)).toEqual([]);
    expect(shownCards(cards, "insurance", "all", matches).map((c) => c.id)).toEqual([TASK]);
    expect(shownCards(cards, "tidy").map((c) => c.title)).toEqual(["Tidy up"]);
  });
  it("brings the first match near the start of a one-line snippet", () => {
    const { container } = render(
      <Highlight text={"Insurer reference is \uE000WINDSCREEN\uE001-42"} before={8} />,
    );
    expect(container.textContent).toBe("…is WINDSCREEN-42");
    const short = render(<Highlight text={"a \uE000b\uE001"} before={8} />);
    expect(short.container.textContent).toBe("a b");
  });
  it("marks matched words and keeps everything else as text", () => {
    const { container } = render(<Highlight text={"abc<script>"} />);
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["b"]);
    expect(screen.getByText("c<script>")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
  });
});
