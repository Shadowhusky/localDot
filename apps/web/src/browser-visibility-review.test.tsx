// @vitest-environment jsdom

import { type LocalDotEvent, ulid } from "@localdot/protocol";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { CellSummary } from "./cells/types.ts";
import { TOKEN_KEY } from "./lib/token.ts";
import { providerFixture } from "./settings/testing.ts";
import { closeStreams } from "./stage/live-stream.ts";
import { fakeChromium } from "./testing/fake-chromium.ts";
import { FakeWebSocket } from "./testing/fake-websocket.ts";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

describe("review: selected physical browser visibility", () => {
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
    window.history.replaceState(null, "", "/");
  });

  for (const connection of ["live", "none"] as const) {
    it(`shows the live browser canvas when the parent desktop stream is ${connection}`, async () => {
      const parentId = ulid();
      const browserId = ulid();
      const sessionId = ulid();
      const parent: CellSummary = {
        id: parentId,
        state: "ready",
        scale: 2,
        createdAt: "2026-10-06T09:00:00.000Z",
        stream: { connection, viewers: connection === "live" ? 1 : 0, lastUpstreamAt: null },
      };
      const browser: CellSummary = {
        ...parent,
        id: browserId,
        stream: { connection: "live", viewers: 1, lastUpstreamAt: null },
      };
      const selection = {
        screen: "browser" as const,
        cellId: browserId,
        geometry: { w: 2560, h: 1600, scale: 2 as const },
        revision: 1,
      };
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/cells") return json([parent]);
        if (path === `/api/cells/${parentId}/live`) return json({ sessionId });
        if (path === `/api/agent/sessions/${sessionId}`)
          return json({
            sessionId,
            cellId: parentId,
            status: "running",
            toolCalls: 0,
            screen: selection,
          });
        if (path === `/api/cells/${parentId}/browser-stream-ticket`)
          return json({
            cellId: browserId,
            path: `/cells/${browserId}/browser/${"t".repeat(22)}/`,
          });
        if (path === `/api/cells/${parentId}/stream-ticket`)
          return json({ path: `/cells/${parentId}/desktop/${"d".repeat(22)}/` });
        if (path === "/api/clock") return json({ nowMicros: 0 });
        if (path === `/api/sessions/${sessionId}/clock`) return json({ originMicros: 0 });
        if (path === "/api/session-index") return json({ sessions: [], next: null });
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
        throw new Error(`Unexpected fixture request: ${path}`);
      }) as typeof fetch;
      const { container } = render(<App fetchImpl={fetchImpl} />);
      const socket = async (path: string) => {
        await waitFor(() =>
          expect(
            FakeWebSocket.instances.some((entry) => new URL(entry.url).pathname === path),
          ).toBe(true),
        );
        return FakeWebSocket.instances.find(
          (entry) => new URL(entry.url).pathname === path,
        ) as FakeWebSocket;
      };
      const parentStatus = await socket(`/api/cells/${parentId}/status`);
      act(() => {
        parentStatus.onopen?.();
        parentStatus.onmessage?.({ data: JSON.stringify(parent) });
      });
      const feed = await socket(`/api/sessions/${sessionId}/stream`);
      const events: LocalDotEvent[] = [
        {
          v: 1,
          id: ulid(),
          seq: 0,
          t: 0,
          agent: "main",
          type: "session.start",
          data: { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "Browser task" },
        },
        {
          v: 1,
          id: ulid(),
          seq: 1,
          t: 1,
          agent: "main",
          type: "screen.switch",
          data: { ...selection, by: "daemon" },
        },
      ];
      act(() => {
        feed.onopen?.();
        for (const event of events) feed.onmessage?.({ data: JSON.stringify(event) });
      });
      const browserStatus = await socket(`/api/browsers/${browserId}/status`);
      act(() => {
        browserStatus.onopen?.();
        browserStatus.onmessage?.({ data: JSON.stringify(browser) });
      });
      await waitFor(() =>
        expect(
          document.querySelector(`iframe[src*="/cells/${browserId}/browser/"]`),
        ).not.toBeNull(),
      );
      expect(container.querySelector(".stage > canvas")).not.toBeNull();
      expect(container.querySelector(".stage")?.classList.contains("lit")).toBe(true);
    });
  }
});
