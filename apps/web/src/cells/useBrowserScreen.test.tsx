// @vitest-environment jsdom
import type { ScreenSelectionSnapshot } from "@localdot/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import type { CellSummary } from "./types.ts";
import { useBrowserScreen } from "./useBrowserScreen.ts";

const parent: CellSummary = {
  id: "01JXYZ0000000000000000ABCD",
  state: "ready",
  scale: 2,
  createdAt: "2026-10-06",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 7 },
};
const selection: ScreenSelectionSnapshot = {
  screen: "browser",
  cellId: "01JXYZ0000000000000000ABCE",
  revision: 2,
  geometry: { w: 2560, h: 1600, scale: 2 },
};
const browser = {
  ...parent,
  id: selection.cellId,
  stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
};
const api = createApi("inert", {
  origin: "http://fixture",
  fetchImpl: async () => new Response("{}"),
});
const socket = () => FakeWebSocket.instances.at(-1) as FakeWebSocket;
const send = (value: unknown, ws = socket()) =>
  act(() => ws.onmessage?.({ data: JSON.stringify(value) }));
beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("waits for the physical browser status and never copies desktop stream health", () => {
  const { result } = renderHook(() => useBrowserScreen(api, parent, selection));
  expect(result.current.cell).toBeNull();
  expect(socket().url).toBe(`ws://fixture/api/browsers/${selection.cellId}/status`);
  act(() => socket().onopen?.());
  expect(result.current.cell).toBeNull();
  send(browser);
  expect(result.current.cell?.stream.connection).toBe("none");
  send({ ...browser, stream: { connection: "stalled", viewers: 2, lastUpstreamAt: 9 } });
  expect(result.current.cell?.stream.connection).toBe("stalled");
  expect(parent.stream.connection).toBe("live");
});

it("keeps the last browser on screen while its status reconnects, stale until a new status", async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useBrowserScreen(api, parent, selection));
  act(() => socket().onopen?.());
  expect(result.current).toMatchObject({ cell: null, stale: false });
  send(browser);
  expect(result.current).toMatchObject({ cell: { id: selection.cellId }, stale: false });
  act(() => socket().onclose?.());
  expect(result.current).toMatchObject({ cell: { id: selection.cellId }, stale: true });
  await act(() => vi.advanceTimersByTimeAsync(500));
  act(() => socket().onopen?.());
  expect(result.current).toMatchObject({ cell: { id: selection.cellId }, stale: true });
  expect(result.current.reconnects).toBe(1);
  send(browser);
  expect(result.current).toMatchObject({ cell: { id: selection.cellId }, stale: false });
  send({ ...browser, createdAt: "old" });
  expect(result.current).toMatchObject({ cell: null, stale: false });
});

it("retires a same-ID previous revision, pauses with its parent, and ignores late old messages", () => {
  const { result, rerender } = renderHook(
    ({ selected, current }) => useBrowserScreen(api, current, selected),
    { initialProps: { selected: selection, current: parent } },
  );
  const old = socket();
  send(browser);
  rerender({ selected: { ...selection, revision: 3 }, current: parent });
  expect(old.closed).toBe(true);
  expect(result.current.cell).toBeNull();
  send(browser, old);
  expect(result.current.cell).toBeNull();
  send(browser);
  expect(result.current.cell?.id).toBe(selection.cellId);
  rerender({ selected: selection, current: { ...parent, paused: true } });
  expect(socket().closed).toBe(true);
  expect(result.current.cell).toBeNull();
});

it.each([
  parent,
  { ...browser, scale: 1 },
  { ...browser, createdAt: "old" },
  { ...browser, token: "private" },
])("refuses a wrong or malformed browser owner", (bad) => {
  const { result } = renderHook(() => useBrowserScreen(api, parent, selection));
  send(browser);
  send(bad);
  expect(result.current.cell).toBeNull();
  expect(result.current.error).toContain("could not be verified");
});

it("does not subscribe when the desktop is selected", () => {
  const { result } = renderHook(() =>
    useBrowserScreen(api, parent, { ...selection, screen: "desktop", cellId: parent.id }),
  );
  expect(result.current.cell).toBeNull();
  expect(FakeWebSocket.instances).toHaveLength(0);
});
