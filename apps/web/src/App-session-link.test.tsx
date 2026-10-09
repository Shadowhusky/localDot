// @vitest-environment jsdom

import { type ApprovalCard, type LocalDotEvent, ulid } from "@localdot/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

// A computer running a task that waits on an approval or a question. The computer says which task
// it runs only once `answer()` is called, as a slow daemon would after a fresh launch.
function daemon(waiting: "approval" | "question" = "approval") {
  const cellId = ulid();
  const sessionId = ulid();
  const approvalId = ulid();
  const askId = ulid();
  const cell: CellSummary = {
    id: cellId,
    state: "ready",
    scale: 2,
    createdAt: "2026-10-09T09:00:00.000Z",
    stream: { connection: "live", viewers: 1, lastUpstreamAt: null },
  };
  const card: ApprovalCard = {
    approvalId,
    generation: 1,
    revision: 1,
    expiresAt: Date.now() + 600_000,
    actionClass: "send",
    risk: "high",
    title: "Send the statement",
    fields: [],
  };
  let answer = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/cells") return json([cell]);
    if (path === `/api/cells/${cellId}/live`) {
      await answered;
      return json({ sessionId });
    }
    if (path === `/api/agent/sessions/${sessionId}`)
      return json({
        sessionId,
        cellId,
        status: "waiting_user",
        toolCalls: 1,
        ...(waiting === "approval" ? { approval: card } : { pendingAsk: askId }),
      });
    if (path === `/api/cells/${cellId}/stream-ticket`)
      return json({ path: `/cells/${cellId}/desktop/${"d".repeat(22)}/` });
    if (path === `/api/cells/${cellId}/quarantine`) return json({ items: [] });
    if (path === "/api/clock") return json({ nowMicros: 0 });
    if (path === `/api/sessions/${sessionId}/clock`) return json({ originMicros: 0 });
    if (path === `/api/sessions/${sessionId}/history`) return new Response("");
    if (path === "/api/conversation") return json({ sessions: [sessionId], more: false });
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
  const event = (seq: number, type: string, data: unknown) =>
    ({ v: 1, id: ulid(), seq, t: seq, agent: "main", type, data }) as LocalDotEvent;
  const events = [
    event(0, "session.start", {
      screen: { w: 2560, h: 1600, scale: 2 },
      os: "linux",
      title: "Pay the bill",
    }),
    waiting === "approval"
      ? event(1, "approval.request", {
          approvalId,
          generation: 1,
          revision: 1,
          expiresAt: card.expiresAt,
          actionClass: "send",
          risk: "high",
          title: card.title,
          kind: "send",
          preview: { fields: [] },
        })
      : event(1, "ask.request", {
          askId,
          question: "Which account pays it?",
          options: [],
          allowText: true,
        }),
  ];
  return { cell, cellId, sessionId, approvalId, askId, fetchImpl, events, answer };
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

it("opens a tapped notification's live task at its decision, even on a fresh launch", async () => {
  const d = daemon();
  window.history.replaceState(null, "", `/#session=${d.sessionId}`);
  render(<App fetchImpl={d.fetchImpl} />);
  const status = await socket(`/api/cells/${d.cellId}/status`);
  act(() => {
    status.onopen?.();
    status.onmessage?.({ data: JSON.stringify(d.cell) });
  });
  // The page can't yet tell whether the task is the live one, so it stays in Watch.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(window.location.hash).toBe("");
  expect(new URLSearchParams(window.location.search).get("replay")).toBeNull();
  d.answer();
  const feed = await socket(`/api/sessions/${d.sessionId}/stream`);
  act(() => {
    feed.onopen?.();
    for (const event of d.events) feed.onmessage?.({ data: JSON.stringify(event) });
  });
  const title = await screen.findByRole("heading", { name: "Send the statement" });
  await waitFor(() => expect(document.activeElement).toBe(title));
  expect(title.id).toBe(`approval-${d.approvalId}`);
  expect(new URLSearchParams(window.location.search).get("replay")).toBeNull();
  expect(screen.queryByRole("main", { name: "Replay" })).toBeNull();
});

it("lands on the question a tapped notification's task asks", async () => {
  const d = daemon("question");
  window.history.replaceState(null, "", `/#session=${d.sessionId}`);
  render(<App fetchImpl={d.fetchImpl} />);
  const status = await socket(`/api/cells/${d.cellId}/status`);
  act(() => {
    status.onopen?.();
    status.onmessage?.({ data: JSON.stringify(d.cell) });
  });
  d.answer();
  const feed = await socket(`/api/sessions/${d.sessionId}/stream`);
  act(() => {
    feed.onopen?.();
    for (const event of d.events) feed.onmessage?.({ data: JSON.stringify(event) });
  });
  await waitFor(() => expect(document.activeElement?.id).toBe(`ask-${d.askId}`));
  expect(document.activeElement?.textContent).toBe("Which account pays it?");
});

it("opens a tapped notification's other task in Replay once the live one is known", async () => {
  const d = daemon();
  const older = ulid();
  window.history.replaceState(null, "", `/#session=${older}`);
  render(<App fetchImpl={d.fetchImpl} />);
  const status = await socket(`/api/cells/${d.cellId}/status`);
  act(() => {
    status.onopen?.();
    status.onmessage?.({ data: JSON.stringify(d.cell) });
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(new URLSearchParams(window.location.search).get("replay")).toBeNull();
  d.answer();
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get("replay")).toBe(older),
  );
});
