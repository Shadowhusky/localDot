// @vitest-environment jsdom

import { type LocalDotEvent, ulid } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { CellSummary } from "./cells/types.ts";
import { TOKEN_KEY } from "./lib/token.ts";
import { providerFixture } from "./settings/testing.ts";
import { closeStreams } from "./stage/live-stream.ts";
import { fakeChromium } from "./testing/fake-chromium.ts";
import { FakeWebSocket } from "./testing/fake-websocket.ts";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

let restore: () => void;
beforeEach(() => {
  restore = fakeChromium();
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, "a".repeat(43));
  window.history.replaceState(null, "", "/");
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  cleanup();
  closeStreams();
  restore();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const SAID = "Draw a dog on the whiteboard";
const REPLIED = "The dog is on the whiteboard, with a red collar.";
const TRIP = "Flights to Lisbon are booked for the 4th of May.";

const event = (seq: number, type: string, data: unknown) =>
  ({ v: 1, id: ulid(), seq, t: seq, agent: "main", type, data }) as LocalDotEvent;
function task(title: string, said: string, replied: string) {
  const id = ulid();
  const history = [
    event(0, "session.start", { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title }),
    event(1, "message.user", { messageId: ulid(), kind: "task", text: said }),
    event(2, "message.assistant", { messageId: ulid(), text: replied }),
    event(3, "session.end", { reason: "done" }),
  ];
  const entry = {
    sessionId: id,
    sessions: [id],
    title,
    said,
    startedAt: new Date().toISOString(),
    ended: "done",
  };
  return { id, history, entry };
}

// A computer at rest whose current conversation is one finished task, with an older conversation
// beside it. Starting a new one or taking the older one up waits on `answer`, as a daemon ending the
// finished task first does.
function daemon() {
  const cellId = ulid();
  const cell: CellSummary = {
    id: cellId,
    state: "ready",
    scale: 2,
    createdAt: "2026-10-09T09:00:00.000Z",
    stream: { connection: "live", viewers: 1, lastUpstreamAt: null },
  };
  const dog = task("Whiteboard dog", SAID, REPLIED);
  const trip = task("Lisbon trip", "Plan the trip to Lisbon", TRIP);
  const tasks = [dog, trip];
  const answer = Promise.withResolvers<void>();
  const posts: { path: string; body: unknown }[] = [];
  let current = [dog.id];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST" && path.startsWith("/api/conversation/")) {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      posts.push({ path, body });
      await answer.promise;
      current = body?.sessionId ? [body.sessionId] : [];
      return json({ sessions: current, more: false });
    }
    if (path === "/api/cells") return json([cell]);
    if (path === `/api/cells/${cellId}/live`) return json({});
    if (path === `/api/cells/${cellId}/stream-ticket`)
      return json({ path: `/cells/${cellId}/desktop/${"d".repeat(22)}/` });
    if (path === `/api/cells/${cellId}/quarantine`) return json({ items: [] });
    if (path === "/api/clock") return json({ nowMicros: 0 });
    const own = tasks.find((each) => path.startsWith(`/api/sessions/${each.id}/`));
    if (own && path.endsWith("/clock")) return json({ originMicros: 0 });
    if (own && path.endsWith("/history"))
      return new Response(own.history.map((line) => `${JSON.stringify(line)}\n`).join(""));
    if (path === "/api/conversation") return json({ sessions: current, more: false });
    if (path === "/api/conversations") return json({ conversations: tasks.map((t) => t.entry) });
    if (path === "/api/session-index") return json({ sessions: [], next: null });
    if (path === "/api/notify/attention") return json({ items: [] });
    if (path === "/api/keys") return json({ keys: [] });
    if (path === "/api/agent/settings") return json({});
    if (path === "/api/agent/providers") return json(providerFixture());
    if (path === "/api/keyd")
      return json({
        online: true,
        bootId: "test",
        sealKey: "test",
        audit: { ok: true },
        hairpin: { state: "active", addresses: 1 },
      });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { cell, cellId, fetchImpl, answer, posts, trip };
}

const socket = async (path: string) => {
  await waitFor(() =>
    expect(FakeWebSocket.instances.some((entry) => new URL(entry.url).pathname === path)).toBe(
      true,
    ),
  );
  return FakeWebSocket.instances.find(
    (entry) => new URL(entry.url).pathname === path,
  ) as FakeWebSocket;
};

async function opened() {
  const d = daemon();
  render(<App fetchImpl={d.fetchImpl} />);
  const status = await socket(`/api/cells/${d.cellId}/status`);
  act(() => {
    status.onopen?.();
    status.onmessage?.({ data: JSON.stringify(d.cell) });
  });
  const thread = await screen.findByRole("region", { name: "Conversation history" });
  await waitFor(() => expect(thread.textContent).toContain(REPLIED));
  return { ...d, thread };
}

it("clears the thread the moment New conversation is pressed, and never draws the old one again", async () => {
  const d = await opened();
  const { thread } = d;
  // Every message the thread draws from here on is recorded, however briefly it stays.
  const drawn: string[] = [];
  const observer = new MutationObserver(() => drawn.push(thread.textContent ?? ""));
  observer.observe(thread, { subtree: true, childList: true, characterData: true });
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  expect(thread.textContent).not.toContain(SAID);
  expect(thread.textContent).not.toContain(REPLIED);
  await act(async () => d.answer.resolve());
  // The new conversation is the one on show once New conversation has nothing left to start.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "New conversation" }).getAttribute("aria-disabled"),
    ).toBe("true"),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  observer.disconnect();
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.filter((text) => text.includes(SAID) || text.includes(REPLIED))).toEqual([]);
  expect(thread.textContent).not.toContain(REPLIED);
});

it("takes up a conversation chosen from the list, its thread coming in once it is read", async () => {
  const d = await opened();
  const { thread } = d;
  fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
  const list = await screen.findByRole("listbox", { name: "Recent conversations" });
  const row = await within(list).findByRole("option", { name: /Lisbon trip/ });
  fireEvent.click(row);
  expect(d.posts).toEqual([{ path: "/api/conversation/continue", body: { sessionId: d.trip.id } }]);
  expect(thread.textContent).not.toContain(REPLIED);
  await act(async () => d.answer.resolve());
  await waitFor(() => expect(thread.textContent).toContain(TRIP));
  expect(thread.textContent).not.toContain(REPLIED);
});
