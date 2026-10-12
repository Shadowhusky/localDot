// @vitest-environment jsdom
import type { ConversationEntry } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveFacts } from "../agent/conversation-list.ts";
import { createApi } from "../lib/api.ts";
import { ConversationList } from "./ConversationList.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const HOUR = 3_600_000;
let next = 0;
function entry(title: string, ago: number, ended: ConversationEntry["ended"] = "done") {
  next++;
  const sessionId = `01M4ECBR5X0R92SYA389FM3Q${String(next).padStart(2, "0")}`;
  return {
    sessionId,
    sessions: [sessionId],
    title,
    said: `${title}, please`,
    startedAt: new Date(Date.now() - ago).toISOString(),
    ended,
  } satisfies ConversationEntry;
}

function daemon(conversations: ConversationEntry[] | Promise<never>, hits: string[] = []) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/search")
      return Response.json({
        hits: hits.map((sessionId) => ({
          sessionId,
          title: null,
          startedAt: null,
          kind: "user",
          snippet: "the boiler again",
          at: new Date().toISOString(),
        })),
        complete: true,
        mode: "fts",
      });
    return Response.json({ conversations: await conversations });
  }) as typeof fetch;
  return createApi("a".repeat(43), { fetchImpl, origin: "http://127.0.0.1" });
}

const QUIET: LiveFacts = { live: null, needsYou: new Set() };

function open(
  conversations: ConversationEntry[] | Promise<never>,
  over: Partial<Parameters<typeof ConversationList>[0]> = {},
) {
  const onPick = vi.fn();
  const onReplay = vi.fn();
  render(
    <ConversationList
      api={daemon(conversations)}
      open
      current={null}
      facts={QUIET}
      onPick={onPick}
      onReplay={onReplay}
      {...over}
    />,
  );
  return {
    onPick,
    onReplay,
    search: screen.getByRole("combobox", { name: "Search conversations" }),
  };
}

const rows = () => screen.getAllByRole("row");

it("lists conversations by day, each with its status and the current one marked", async () => {
  // Mid-afternoon, so an hour or two ago is still today whenever the suite runs.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 9, 15) });
  const today = entry("Book the hotel", HOUR);
  const running = entry("Tidy my Downloads", 2 * HOUR, null);
  const failed = entry("Summarise the deck", 26 * HOUR, "error");
  const old = entry("Reply to the landlord", 200 * HOUR, "stopped");
  open([running, today, failed, old], {
    current: today.sessionId,
    facts: { live: running.sessionId, needsYou: new Set() },
  });
  const list = await screen.findByRole("grid", { name: "Recent conversations" });
  expect([...list.querySelectorAll(".conversations-day")].map((head) => head.textContent)).toEqual([
    "Today",
    "Yesterday",
    "Earlier",
  ]);
  expect(list.textContent).toMatch(/^Today.*Yesterday.*Earlier/);
  expect(rows().map((row) => within(row).getByRole("img").getAttribute("aria-label"))).toEqual([
    "Running",
    "Done",
    "Failed",
    "Stopped",
  ]);
  const current = rows().find((row) => row.getAttribute("aria-current") === "true");
  expect(current?.textContent).toContain("Book the hotel");
});

it("moves through the rows with the arrows and takes up the one chosen with Return", async () => {
  const a = entry("First", HOUR);
  const b = entry("Second", 2 * HOUR);
  const c = entry("Third", 30 * HOUR);
  const { onPick, search } = open([a, b, c]);
  await screen.findByRole("grid");
  const active = () => document.getElementById(search.getAttribute("aria-activedescendant") ?? "");
  expect(active()?.textContent).toContain("First");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(active()?.textContent).toContain("Third");
  expect(active()?.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(active()?.textContent).toContain("Third");
  fireEvent.keyDown(search, { key: "ArrowUp" });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith(b.sessionId, b.sessions);
  fireEvent.click(within(rows()[0] as HTMLElement).getAllByRole("button")[0] as HTMLElement);
  expect(onPick).toHaveBeenLastCalledWith(a.sessionId, a.sessions);
});

it("filters by title and what was said, and says when nothing matches", async () => {
  const { search } = open([entry("Book the hotel", HOUR), entry("Draw a dog", 2 * HOUR)]);
  await screen.findByRole("grid");
  fireEvent.change(search, { target: { value: "DOG" } });
  expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining("Draw a dog")]);
  fireEvent.change(search, { target: { value: "hotel please" } });
  expect(rows()).toHaveLength(1);
  fireEvent.change(search, { target: { value: "x" } });
  expect(screen.getByText("No conversations match “x”")).toBeTruthy();
});

it("finds a conversation by words its tasks said, through the search index", async () => {
  const boiler = entry("Landlord", HOUR);
  const fetched = daemon([boiler, entry("Draw a dog", 2 * HOUR)], [boiler.sessionId]);
  render(
    <ConversationList
      api={fetched}
      open
      current={null}
      facts={QUIET}
      onPick={() => {}}
      onReplay={() => {}}
    />,
  );
  await screen.findByRole("grid");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "boiler" } });
  await waitFor(() =>
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining("Landlord")]),
  );
});

it("keeps other conversations out of reach while the current task is at work", async () => {
  const current = entry("Working one", HOUR, null);
  const other = entry("Another", 2 * HOUR);
  const { onPick, search } = open([current, other], {
    current: current.sessionId,
    reason: "Finish or stop the current task first.",
  });
  await screen.findByRole("grid");
  expect(screen.getAllByText("Finish or stop the current task first.")[0]).toBeTruthy();
  const blocked = rows().find((row) => row.textContent?.includes("Another")) as HTMLElement;
  expect(blocked.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(within(blocked).getAllByRole("button")[0] as HTMLElement);
  expect(onPick).not.toHaveBeenCalled();
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onPick).toHaveBeenCalledWith(current.sessionId, current.sessions);
});

it("shows dot while reading, an empty state when there are none, and the way to Replay", async () => {
  const { onReplay } = open(new Promise<never>(() => {}));
  expect(screen.getByRole("status").textContent).toContain("Loading");
  cleanup();
  const empty = open([]);
  expect(await screen.findByText("No conversations yet")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "See all in Replay" }));
  expect(empty.onReplay).toHaveBeenCalled();
  expect(onReplay).not.toHaveBeenCalled();
});

it("deletes a conversation only after confirmation and refreshes the list", async () => {
  const previous = entry("Old task", HOUR);
  const deleted: string[] = [];
  const api = createApi("fixture", {
    origin: "http://fixture.test",
    fetchImpl: async (url, init) => {
      if (init?.method === "DELETE") {
        deleted.push(new URL(String(url)).pathname);
        return new Response(null, { status: 204 });
      }
      return Response.json({ conversations: deleted.length ? [] : [previous] });
    },
  });
  const onDeleted = vi.fn();
  open([], { api, onDeleted });
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Old task" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete conversation" }));
  expect(deleted).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText("No conversations yet");
  expect(deleted).toEqual([`/api/conversations/${previous.sessionId}`]);
  expect(onDeleted).toHaveBeenCalledWith(previous.sessions);
});
