// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { useLiveSession } from "./useLiveSession.ts";

const CELL = "01JXYZ0000000000000000CELL",
  SESSION = "01JXYZ0000000000000000SESS";
const ready: CellSummary = {
  id: CELL,
  state: "ready",
  scale: 1,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 },
};
beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  let live: string | null = null;
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/live"))
      return live ? Response.json({ sessionId: live }) : new Response(null, { status: 204 });
    return Response.json({ originMicros: 0, serverMicros: 0 });
  });
  const api = createApi("fixture", { origin: "http://127.0.0.1:4747", fetchImpl });
  const view = renderHook(() => useLiveSession(api, ready, { current: null }));
  return {
    view,
    polls: () =>
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith(`/cells/${CELL}/live`))
        .length,
    start: (id: string) => {
      live = id;
    },
  };
}
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

it("slows to one look every five seconds while the computer has no task", async () => {
  const error = vi.spyOn(console, "error");
  const f = setup();
  await wait(5_000);
  const quick = f.polls();
  expect(quick).toBeGreaterThanOrEqual(5);
  await wait(55_000);
  expect(f.polls() - quick).toBeLessThanOrEqual(11);
  expect(f.view.result.current.sessionId).toBeNull();
  expect(error).not.toHaveBeenCalled();
});

it("looks again at once when a task is started from this page", async () => {
  const f = setup();
  await wait(30_000);
  f.start(SESSION);
  const before = f.polls();
  await act(async () => {
    f.view.result.current.check();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(f.polls()).toBe(before + 1);
  expect(f.view.result.current.sessionId).toBe(SESSION);
});
