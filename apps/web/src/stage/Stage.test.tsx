// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { FakeWorker, fakeChromium, playInClient } from "../testing/fake-chromium.ts";
import { Stage } from "./Stage.tsx";

const CELL = "01JXYZ0000000000000000ABCD";
const ready: CellSummary = {
  id: CELL,
  state: "ready",
  scale: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
};
const ticketPath = (n: number) => `/cells/${CELL}/desktop/${String(n).padStart(22, "T")}/`;
const client = () => document.querySelector<HTMLIFrameElement>("iframe.desktop-frame");

afterEach(cleanup);

describe("Stage", () => {
  it("says a Chromium browser is needed where frames cannot be tapped", () => {
    render(
      <Stage
        cell={ready}
        api={createApi("a".repeat(43), { origin: "http://127.0.0.1:4750" })}
        reconnects={0}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "This browser has no MediaStreamTrackProcessor. Open localDot in Google Chrome or another Chromium browser.",
    );
    expect(client()).toBeNull();
  });
});

describe("Stage in a Chromium browser", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = fakeChromium();
  });
  afterEach(() => {
    vi.useRealTimers();
    restore();
    window.localStorage.clear();
  });

  // The daemon mints ticket n for the n-th request.
  function daemon() {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      const path = ticketPath(calls.length);
      return new Response(JSON.stringify({ ticket: path.split("/")[4], path }), { status: 200 });
    }) as typeof fetch;
    return { api: createApi("a".repeat(43), { fetchImpl }), calls };
  }

  it("loads the client, out of sight and inert, from the path of a ticket it mints", async () => {
    const { api, calls } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} />);
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(ticketPath(1)));
    expect(client()?.hasAttribute("inert")).toBe(true);
    expect(calls).toEqual([`POST /api/cells/${CELL}/stream-ticket`]);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]?.sent[0]?.message.type).toBe("init");
  });

  it("drops what the client stored under the cell's earlier tickets when it mints", async () => {
    const page = (path: string) => `${window.location.origin}${path}`.replace(/[^\w.-]/g, "_");
    const old = `${page(`/cells/${CELL}/desktop/${"O".repeat(22)}/`)}_stream_mode`;
    window.localStorage.setItem(old, "webrtc");
    window.localStorage.setItem("localdot.token", "kept");
    const { api } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} />);
    await waitFor(() => expect(client()).not.toBeNull());
    expect(window.localStorage.getItem(old)).toBeNull();
    expect(window.localStorage.getItem("localdot.token")).toBe("kept");
  });

  it("mints again and loads a fresh client when the daemon socket reconnects", async () => {
    const { api, calls } = daemon();
    const view = render(<Stage cell={ready} api={api} reconnects={0} />);
    await waitFor(() => expect(client()).not.toBeNull());
    const before = client();
    view.rerender(<Stage cell={ready} api={api} reconnects={1} />);
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(ticketPath(2)));
    expect(client()).not.toBe(before);
    expect(calls).toHaveLength(2);
  });

  it("mints again after 10 s without a video element in the client, and never while it has one", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    const { api, calls } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} />);
    await waitFor(() => expect(client()).not.toBeNull());
    const before = client() as HTMLIFrameElement;
    playInClient(before, "t1");
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(calls).toHaveLength(1);
    before.contentDocument?.getElementById("videoStream")?.remove();
    await act(async () => vi.advanceTimersByTime(9_000));
    expect(calls).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1_500));
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(ticketPath(2)));
    expect(client()).not.toBe(before);
  });

  it("hands each new track of the client to the render worker once, seeded with its current frame", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    const { api } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} />);
    await waitFor(() => expect(client()).not.toBeNull());
    const frames = () => FakeWorker.instances[0]?.sent.filter((s) => s.message.type === "frames");
    playInClient(client() as HTMLIFrameElement, "t1");
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(frames()).toHaveLength(1);
    const [sent] = frames() ?? [];
    const first = sent?.message.first as { source?: unknown } | undefined;
    expect(first).toBeInstanceOf(VideoFrame);
    expect(first?.source).toBe(client()?.contentDocument?.getElementById("videoStream"));
    expect(sent?.transfer).toEqual([sent?.message.readable, first]);
    playInClient(client() as HTMLIFrameElement, "t2");
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(frames()).toHaveLength(2);
  });

  it("removes the client and stops the frames when the cell leaves ready", async () => {
    const { api } = daemon();
    const view = render(<Stage cell={ready} api={api} reconnects={0} />);
    await waitFor(() => expect(client()).not.toBeNull());
    view.rerender(<Stage cell={{ ...ready, state: "stopping" }} api={api} reconnects={0} />);
    expect(client()).toBeNull();
    expect(FakeWorker.instances[0]?.sent.at(-1)?.message.type).toBe("stop");
  });

  it("veils the stage while the stream is stalled", () => {
    const { api } = daemon();
    const stalled = { ...ready, stream: { ...ready.stream, connection: "stalled" as const } };
    const view = render(<Stage cell={stalled} api={api} reconnects={0} />);
    expect(document.querySelector(".stage-veil.on")?.textContent).toBe("Reconnecting…");
    const live = { ...ready, stream: { ...ready.stream, connection: "live" as const } };
    view.rerender(<Stage cell={live} api={api} reconnects={0} />);
    expect(document.querySelector(".stage-veil.on")).toBeNull();
  });
});
