// @vitest-environment jsdom

import { type ApprovalCard, type LocalDotEvent, ulid } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { CellSummary } from "./cells/types.ts";
import { TOKEN_KEY } from "./lib/token.ts";
import { providerFixture } from "./settings/testing.ts";
import { closeStreams } from "./stage/live-stream.ts";
import { fakeChromium } from "./testing/fake-chromium.ts";
import { FakeWebSocket } from "./testing/fake-websocket.ts";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

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

const TITLE = "An app named WeChat wants to connect to long.weixin.qq.com on port 8080";

// A task whose app waits on a connection card, while dot works or while the user holds the computer.
function daemon({ held }: { held: boolean }) {
  const cellId = ulid();
  const sessionId = ulid();
  const takeoverId = ulid();
  const cell: CellSummary = {
    id: cellId,
    state: "ready",
    scale: 2,
    createdAt: "2026-10-09T09:00:00.000Z",
    stream: { connection: "live", viewers: 1, lastUpstreamAt: null },
  };
  const card: ApprovalCard = {
    approvalId: ulid(),
    generation: 1,
    revision: 1,
    expiresAt: Date.now() + 120_000,
    actionClass: "network",
    risk: "medium",
    title: TITLE,
    why: "WeChat hasn't used this destination before.",
    fields: [
      ["App", "WeChat"],
      ["Destination", "long.weixin.qq.com · port 8080"],
      ["For the task", "Sign in to WeChat"],
    ],
    always: [{ scope: "task", label: "For this task", destination: "long.weixin.qq.com:8080" }],
  };
  const posts: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") posts.push(path);
    if (path === "/api/cells") return json([cell]);
    if (path === `/api/cells/${cellId}/live`) return json({ sessionId });
    if (path === `/api/agent/sessions/${sessionId}/takeover`)
      return json({ requestId: takeoverId }, 202);
    if (path === `/api/agent/sessions/${sessionId}/approvals/answer`)
      return new Response("approval is not waiting", { status: 409 });
    if (path === `/api/agent/sessions/${sessionId}`)
      return json({
        sessionId,
        cellId,
        status: held ? "waiting_user" : "running",
        toolCalls: 3,
        connection: card,
        ...(held ? { pendingTakeover: takeoverId, manualControl: "ready" } : {}),
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
  const { fields, ...request } = card;
  const events = [
    ["session.start", { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "WeChat" }],
    ...(held
      ? [["takeover.request", { requestId: takeoverId, reason: "other", note: "", by: "user" }]]
      : []),
    ["approval.request", { ...request, kind: "permission", preview: { fields } }],
  ].map(([type, data], seq) => event(seq, type as string, data));
  return { cell, cellId, sessionId, fetchImpl, events, posts };
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

async function open(d: ReturnType<typeof daemon>) {
  render(<App fetchImpl={d.fetchImpl} />);
  const status = await socket(`/api/cells/${d.cellId}/status`);
  act(() => {
    status.onopen?.();
    status.onmessage?.({ data: JSON.stringify(d.cell) });
  });
  const feed = await socket(`/api/sessions/${d.sessionId}/stream`);
  act(() => {
    feed.onopen?.();
    for (const event of d.events) feed.onmessage?.({ data: JSON.stringify(event) });
  });
}

it("takes the computer while an app's connection card waits, and leaves the card to its own answer", async () => {
  const d = daemon({ held: false });
  await open(d);
  await screen.findByRole("heading", { name: TITLE });
  const island = document.querySelector(".island") as HTMLElement;
  const take = within(island).getByRole("button", { name: "Take control" });
  await waitFor(() => expect(take.getAttribute("aria-disabled")).not.toBe("true"));
  fireEvent.click(take);
  await waitFor(() => expect(d.posts).toContain(`/api/agent/sessions/${d.sessionId}/takeover`));
  expect(d.posts).not.toContain(`/api/agent/sessions/${d.sessionId}/approvals/answer`);
});

it("shows an app's connection card out of the island while the user holds the computer", async () => {
  const d = daemon({ held: true });
  await open(d);
  await waitFor(() =>
    expect(screen.getByTestId("hud-status").textContent).toBe("You're in control"),
  );
  const island = document.querySelector(".island") as HTMLElement;
  expect(await within(island).findByRole("heading", { name: TITLE })).toBeTruthy();
  expect(island.hasAttribute("data-open")).toBe(true);
  expect(within(island).getByRole("button", { name: /Allow/ })).toBeTruthy();
});

it("shows the card in the phone's sheet while the user holds the computer", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /width < (700|1100)px/.test(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const d = daemon({ held: true });
  await open(d);
  const title = await screen.findByRole("heading", { name: TITLE });
  expect(title.closest(".island")).toBeNull();
  expect(screen.getByRole("button", { name: /Allow/ })).toBeTruthy();
});
