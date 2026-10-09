// @vitest-environment jsdom
import { emptyManifest, type SessionCard, ulid } from "@localdot/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { TOKEN_KEY } from "../lib/token.ts";
import { providerFixture } from "../settings/testing.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, "a".repeat(43));
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("VideoEncoder", class {});
  vi.stubGlobal("OffscreenCanvas", class {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function recorded(durationMs: number, host?: "ready") {
  const card: SessionCard = {
    id: ulid(),
    title: "Totals",
    startedAt: "2026-10-03T10:00:00.000Z",
    durationMs,
    verdict: "done",
    steps: 1,
    failedSteps: 0,
    coverFrameId: null,
    screen: null,
    recording: { state: "complete", bytes: 1 },
  };
  const event = (seq: number, ms: number, type: string, data: unknown, step?: string) => ({
    v: 1,
    id: ulid(),
    seq,
    t: ms * 1000,
    agent: "main",
    type,
    data,
    ...(step ? { step } : {}),
  });
  const events = [
    event(0, 0, "session.start", {
      screen: { w: 1280, h: 800, scale: 1 },
      os: "linux",
      title: "T",
    }),
    event(1, 1000, "step.start", { kind: "gui" }, "open"),
    event(2, 2500, "step.end", { status: "ok" }, "open"),
    event(3, durationMs, "session.end", { reason: "done" }),
  ];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/session-index") return Response.json({ sessions: [card], next: null });
    if (path === `/api/sessions/${card.id}/card`) return Response.json(card);
    if (path === `/api/sessions/${card.id}/recording`)
      return Response.json({
        manifest: emptyManifest("none"),
        live: false,
        upto: 0,
        servedBytes: 0,
      });
    if (path === `/api/sessions/${card.id}/events`)
      return new Response(events.map((e) => JSON.stringify(e)).join("\n"));
    if (path === "/api/exports" && host)
      return Response.json({
        host: { state: host, maxPixels: { mp4: 8_294_400, webm: 8_294_400 } },
        exports: [],
      });
    if (path === "/api/agent/settings") return Response.json({});
    if (path === "/api/agent/providers") return Response.json(providerFixture());
    if (path === "/api/keyd") return Response.json({ online: false });
    if (path.startsWith("/api/sessions/")) return new Response(null, { status: 404 });
    return Response.json([]);
  }) as typeof fetch;
  return { card, fetchImpl };
}

it("opens Export on a result's part of the recording, kept inside it, and forgets the request", async () => {
  const task = recorded(60_000);
  window.history.replaceState(null, "", `/?replay=${task.card.id}&t=10000&export=10000-900000`);
  render(<App fetchImpl={task.fetchImpl} />);
  const sheet = await screen.findByRole("dialog", { name: "Export video" });
  expect(within(sheet).getByText("0:10 – 1:00")).toBeTruthy();
  expect(within(sheet).getByRole("radio", { name: "Selection" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  await waitFor(() => expect(new URLSearchParams(window.location.search).get("export")).toBeNull());
  expect(new URLSearchParams(window.location.search).get("replay")).toBe(task.card.id);
});

it("opens Export from the link through the host when this browser can't make the video", async () => {
  vi.stubGlobal("VideoEncoder", undefined);
  const task = recorded(60_000, "ready");
  window.history.replaceState(null, "", `/?replay=${task.card.id}&export=0-20000`);
  render(<App fetchImpl={task.fetchImpl} />);
  const sheet = await screen.findByRole("dialog", { name: "Export video" });
  expect(within(sheet).getByText("0:00 – 0:20")).toBeTruthy();
});
