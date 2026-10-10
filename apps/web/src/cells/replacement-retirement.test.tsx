// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import type { SocketOptions } from "../lib/socket.ts";
import type { CellSummary } from "./types.ts";
import { useCell } from "./useCell.ts";

const sockets = vi.hoisted(() => ({ values: [] as SocketOptions[] }));
vi.mock("../lib/socket.ts", () => ({
  openSocket: (opts: SocketOptions) => {
    sockets.values.push(opts);
    return { close: vi.fn() };
  },
}));
const OLD = "01J00000000000000000000001",
  FRESH = "01J00000000000000000000002";
const summary = (id = OLD, over: Partial<CellSummary> = {}): CellSummary => ({
  id,
  state: "ready",
  scale: 1,
  createdAt: "",
  stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
  ...over,
});
afterEach(() => {
  cleanup();
  sockets.values = [];
  vi.restoreAllMocks();
});
async function setup(initial: CellSummary, candidate = summary(FRESH)) {
  const api = createApi("fixture", {
    origin: "https://owned.invalid",
    fetchImpl: vi.fn(async (url) => {
      if (String(url).endsWith("/api/cells")) return Response.json([initial]);
      if (String(url).endsWith(`/api/cells/${FRESH}`)) return Response.json(candidate);
      throw new Error("Unexpected endpoint in exact-owner fixture");
    }),
  });
  const hook = renderHook(() => useCell(api));
  await waitFor(() => expect(hook.result.current.pending).toBeNull());
  expect(hook.result.current.cell?.id).toBe(OLD);
  const socket = sockets.values[0];
  if (!socket) throw new Error("The original owner socket is missing");
  return { ...hook, socket };
}
it("fenced removed status retains the original recovery identity until a separately verified Ready selection", async () => {
  const h = await setup(summary(OLD, { fenced: { revision: 4 } }));
  act(() =>
    h.socket.handlers.onMessage(
      JSON.stringify(summary(OLD, { state: "removed", fenced: { revision: 4 } })),
    ),
  );
  expect(h.result.current.cell).toMatchObject({
    id: OLD,
    state: "removed",
    fenced: { revision: 4 },
  });
  await act(async () => expect(await h.result.current.selectReady(FRESH)).toBe(true));
  expect(h.result.current.cell).toMatchObject({ id: FRESH, state: "ready" });
  expect(h.result.current.cell?.fenced).toBeUndefined();
});
it("replacement-held removed status stays visible while an unverified candidate cannot be selected", async () => {
  const h = await setup(
    summary(OLD, { replacementPending: true }),
    summary(FRESH, { replacementPending: true }),
  );
  act(() =>
    h.socket.handlers.onMessage(
      JSON.stringify(summary(OLD, { state: "removed", replacementPending: true })),
    ),
  );
  expect(h.result.current.cell).toMatchObject({
    id: OLD,
    state: "removed",
    replacementPending: true,
  });
  await act(async () => expect(await h.result.current.selectReady(FRESH)).toBe(false));
  expect(h.result.current.cell?.id).toBe(OLD);
});
it("ordinary removed status still clears a computer that has no recovery fence", async () => {
  const h = await setup(summary());
  act(() => h.socket.handlers.onMessage(JSON.stringify(summary(OLD, { state: "removed" }))));
  expect(h.result.current.cell).toBeNull();
});
it("a late removed status from the retired socket cannot clear the newly verified owner", async () => {
  const h = await setup(summary(OLD, { fenced: { revision: 4 } }));
  await act(async () => expect(await h.result.current.selectReady(FRESH)).toBe(true));
  act(() =>
    h.socket.handlers.onMessage(
      JSON.stringify(summary(OLD, { state: "removed", fenced: { revision: 4 } })),
    ),
  );
  expect(h.result.current.cell).toMatchObject({ id: FRESH, state: "ready" });
});

it("a newly created computer adopts its authenticated owner before accepting live status", async () => {
  const posts: string[] = [];
  const api = createApi("fixture", {
    origin: "https://owned.invalid",
    fetchImpl: vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        posts.push(String(url));
        return Response.json(summary(OLD, { state: "starting" }), { status: 202 });
      }
      if (String(url).endsWith("/api/cells")) return Response.json([]);
      throw new Error("Unexpected endpoint in bootstrap fixture");
    }),
  });
  const h = renderHook(() => useCell(api));
  await waitFor(() => expect(h.result.current.pending).toBeNull());
  act(() => h.result.current.start());
  await waitFor(() => expect(h.result.current.cell?.id).toBe(OLD));
  const socket = sockets.values[0];
  if (!socket) throw new Error("The new owner socket was not established");
  act(() =>
    socket.handlers.onMessage(
      JSON.stringify(
        summary(OLD, { stream: { connection: "live", viewers: 1, lastUpstreamAt: 1 } }),
      ),
    ),
  );
  expect(h.result.current.cell).toMatchObject({
    id: OLD,
    state: "ready",
    stream: { connection: "live" },
  });
  expect(posts).toEqual(["https://owned.invalid/api/cells"]);
});

it("refresh selects the newest fenced computer instead of an older failed replacement", async () => {
  const api = createApi("fixture", {
    origin: "https://owned.invalid",
    fetchImpl: vi.fn(async () =>
      Response.json([
        summary(OLD, { state: "failed", fenced: { revision: 1 } }),
        summary(FRESH, { paused: true, fenced: { revision: 1 } }),
      ]),
    ),
  });
  const h = renderHook(() => useCell(api));
  await waitFor(() => expect(h.result.current.pending).toBeNull());
  expect(h.result.current.cell?.id).toBe(FRESH);
});
it("a completed historical replacement can select its successor's recovery screen without granting Ready", async () => {
  const h = await setup(
    summary(OLD, { fenced: { revision: 4 } }),
    summary(FRESH, { fenced: { revision: 1 }, paused: true }),
  );
  await act(async () => expect(await h.result.current.selectReady(FRESH)).toBe(false));
  await act(async () => expect(await h.result.current.selectRecovery(FRESH)).toBe(true));
  expect(h.result.current.cell).toMatchObject({ id: FRESH, fenced: { revision: 1 }, paused: true });
});
it("recovery selection refuses an unfenced candidate", async () => {
  const h = await setup(summary(OLD, { fenced: { revision: 4 } }));
  await act(async () => expect(await h.result.current.selectRecovery(FRESH)).toBe(false));
  expect(h.result.current.cell?.id).toBe(OLD);
});
