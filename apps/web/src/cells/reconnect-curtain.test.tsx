// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import type { SocketOptions } from "../lib/socket.ts";
import { useCurtain } from "../shell/curtain.ts";
import { hudFor } from "./hud-state.ts";
import type { CellSummary } from "./types.ts";
import { useCell } from "./useCell.ts";

const sockets = vi.hoisted(() => ({ values: [] as SocketOptions[] }));
vi.mock("../lib/socket.ts", () => ({
  openSocket: (opts: SocketOptions) => {
    sockets.values.push(opts);
    return { close: vi.fn() };
  },
}));

const ID = "01J00000000000000000000001";
const summary = (
  state: CellSummary["state"],
  connection: CellSummary["stream"]["connection"],
): CellSummary => ({
  id: ID,
  state,
  scale: 2,
  createdAt: "",
  stream: { connection, viewers: connection === "none" ? 0 : 1, lastUpstreamAt: null },
});

afterEach(() => {
  cleanup();
  sockets.values = [];
  vi.useRealTimers();
});

async function setup(initial: CellSummary) {
  const api = createApi("fixture", {
    origin: "https://owned.invalid",
    fetchImpl: vi.fn(async () => Response.json([initial])),
  });
  const hook = renderHook(() => {
    const view = useCell(api);
    const hud = hudFor(view);
    return { hud, curtain: useCurtain(hud.phase, false) };
  });
  await waitFor(() => expect(hook.result.current.hud.phase).not.toBe("checking"));
  const socket = sockets.values[0];
  if (!socket) throw new Error("missing status socket");
  const status = (cell: CellSummary) => act(() => socket.handlers.onMessage(JSON.stringify(cell)));
  return { ...hook, status };
}

it("keeps the curtain down while a live computer's stream reconnects, as on focus or a new tab", async () => {
  const h = await setup(summary("ready", "live"));
  expect(h.result.current.curtain.up).toBe(false);
  // The page came back into view: the old relay closes and a fresh one connects.
  for (const connection of ["none", "connecting", "disconnected", "connecting", "live"] as const) {
    h.status(summary("ready", connection));
    expect(h.result.current.curtain.up, connection).toBe(false);
    expect(h.result.current.hud.phase, connection).toBe(
      connection === "live" ? "live" : "reconnecting",
    );
  }
});

it("still raises the curtain when the computer itself goes down and comes back", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const h = await setup(summary("ready", "live"));
  h.status(summary("stopping", "none"));
  expect(h.result.current.curtain).toMatchObject({ up: true, phase: "stopping" });
  h.status(summary("starting", "none"));
  h.status(summary("ready", "none"));
  expect(h.result.current.curtain).toMatchObject({ up: true, phase: "connecting" });
  h.status(summary("ready", "live"));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(h.result.current.curtain.up).toBe(false);
  h.status(summary("ready", "connecting"));
  expect(h.result.current.curtain.up).toBe(false);
});

it("waits under the curtain for the first picture of a computer it found already up", async () => {
  const h = await setup(summary("ready", "none"));
  expect(h.result.current.curtain).toMatchObject({ up: true, phase: "connecting" });
});

it("does not let a delayed stopped list overwrite the newer ready socket snapshot", async () => {
  let finish: (response: Response) => void = () => {};
  let lists = 0;
  const api = createApi("fixture", {
    origin: "https://owned.invalid",
    fetchImpl: vi.fn(async (url) => {
      if (String(url).endsWith("/api/whoami")) return Response.json({});
      if (++lists === 1) return Response.json([summary("ready", "live")]);
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }),
  });
  const h = renderHook(() => useCell(api));
  await waitFor(() => expect(h.result.current.cell?.state).toBe("ready"));
  act(() => sockets.values[0]?.handlers.onRefused?.());
  await waitFor(() => expect(lists).toBe(2));
  act(() => sockets.values[0]?.handlers.onMessage(JSON.stringify(summary("ready", "live"))));
  await act(async () => finish(Response.json([summary("stopped", "none")])));
  expect(h.result.current.cell?.state).toBe("ready");
});

it("retains the last verified screen on a failed refresh and recovers status from the socket", async () => {
  let fail = false;
  const api = createApi("fixture", {
    origin: "https://owned.invalid",
    fetchImpl: vi.fn(async () => {
      if (fail) throw new Error("offline");
      return Response.json([summary("ready", "live")]);
    }),
  });
  const h = renderHook(() => useCell(api));
  await waitFor(() => expect(h.result.current.pending).toBeNull());
  fail = true;
  act(() => h.result.current.retry());
  await waitFor(() => expect(h.result.current.status).toBe("unknown"));
  expect(h.result.current.cell?.state).toBe("ready");
  expect(hudFor({ ...h.result.current, viewer: true, picture: "held" }).phase).toBe("reconnecting");
  act(() => sockets.values[0]?.handlers.onMessage(JSON.stringify(summary("ready", "live"))));
  expect(h.result.current.status).toBe("known");
});
