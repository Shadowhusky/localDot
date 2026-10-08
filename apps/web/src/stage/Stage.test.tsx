// @vitest-environment jsdom

import type { ManualInput } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { FakeWorker, fakeChromium, playInClient } from "../testing/fake-chromium.ts";
import { Stage, type StageHandle } from "./Stage.tsx";

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
  it("says which browser can show the desktop where frames cannot be tapped", () => {
    render(
      <Stage
        cell={ready}
        api={createApi("a".repeat(43), { origin: "http://127.0.0.1:4750" })}
        reconnects={0}
        listed={[CELL]}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "This browser lacks WebCodecs. Open localDot in a current Chromium browser.",
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

  it("renders replay with no cell, ticket, iframe, or live track processor", async () => {
    const { api, calls } = daemon();
    const stage = createRef<StageHandle>();
    vi.stubGlobal("MediaStreamTrackProcessor", undefined);
    render(<Stage ref={stage} mode="replay" cell={null} api={api} reconnects={0} listed={[]} />);
    expect(screen.getByLabelText("The virtual computer")).toBeTruthy();
    expect(client()).toBeNull();
    expect(calls).toHaveLength(0);
    const listener = vi.fn();
    const unsubscribe = stage.current?.replay.onReplay(listener);
    stage.current?.replay.open({
      sessionId: CELL,
      origin: "http://127.0.0.1:4750",
      authorization: "Bearer fixture",
      video: null,
      gaps: [],
    });
    stage.current?.replay.seek(120, "exact");
    const worker = FakeWorker.instances[0];
    expect(worker?.sent.some((entry) => entry.message.type === "replay-open")).toBe(true);
    act(() =>
      worker?.onmessage?.({ data: { type: "replay-time", tMs: 120, playing: false, idle: false } }),
    );
    expect(listener).toHaveBeenCalledWith({
      type: "replay-time",
      tMs: 120,
      playing: false,
      idle: false,
    });
    unsubscribe?.();
    await expect(stage.current?.replay.probe({ op: "stats" })).rejects.toThrow("disabled");
  });

  it("detaches the live viewer for replay and mints a fresh ticket on return", async () => {
    const { api, calls } = daemon();
    const stage = createRef<StageHandle>();
    const view = render(
      <Stage ref={stage} cell={ready} api={api} reconnects={0} listed={[CELL]} />,
    );
    await waitFor(() => expect(client()).not.toBeNull());
    const first = client()?.src;
    playInClient(client() as HTMLIFrameElement, "replay-switch-track");
    await waitFor(() =>
      expect(FakeWorker.instances[0]?.sent.some((entry) => entry.message.type === "frames")).toBe(
        true,
      ),
    );
    view.rerender(
      <Stage ref={stage} mode="replay" cell={ready} api={api} reconnects={0} listed={[CELL]} />,
    );
    expect(client()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(FakeWorker.instances[0]?.sent.at(-1)?.message.type).not.toBe("frames");
    view.rerender(
      <Stage ref={stage} mode="live" cell={ready} api={api} reconnects={0} listed={[CELL]} />,
    );
    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => expect(client()).not.toBeNull());
    expect(client()?.src).not.toBe(first);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("commits atomic input on click against the current takeover and real backing viewport without another worker", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 20,
      top: 30,
      width: 640,
      height: 600,
      right: 660,
      bottom: 630,
      x: 20,
      y: 30,
      toJSON: () => ({}),
    });
    const { api, calls } = daemon();
    const input = vi.fn<(id: string, input: ManualInput) => Promise<boolean>>(async () => true);
    const manual = {
      requestId: "old-takeover",
      enabled: true,
      screen: { w: 2560, h: 1600 },
      button: "left" as const,
      count: 1 as const,
      input,
    };
    const view = render(
      <Stage cell={ready} api={api} reconnects={0} listed={[CELL]} manual={manual} />,
    );
    const surface = screen.getByRole<HTMLButtonElement>("button", {
      name: "Click on the computer",
    });
    await waitFor(() => expect(client()).not.toBeNull());
    playInClient(client() as HTMLIFrameElement, "owned-input-track");
    await waitFor(() =>
      expect(FakeWorker.instances[0]?.sent.some((row) => row.message.type === "frames")).toBe(true),
    );
    const sourceId = FakeWorker.instances[0]?.sent.findLast((row) => row.message.type === "frames")
      ?.message.sourceId;
    act(() =>
      FakeWorker.instances[0]?.onmessage?.({
        data: {
          type: "stats",
          sourceId,
          stats: { presented: 1, fps: 30, lastFrameAt: 1, width: 2560, height: 1600 },
        },
      }),
    );
    await waitFor(() => expect(surface.disabled).toBe(false));
    fireEvent.pointerDown(surface, { clientX: 340, clientY: 330 });
    fireEvent.pointerUp(surface, { clientX: 340, clientY: 330 });
    fireEvent.click(surface, { detail: 1, clientX: 340, clientY: 50 }); // Letterboxing.
    fireEvent.click(surface, { detail: 0, clientX: 340, clientY: 330 }); // Keyboard activation.
    expect(input).not.toHaveBeenCalled();
    fireEvent.click(surface, { detail: 1, clientX: 340, clientY: 330 });
    expect(input).toHaveBeenLastCalledWith("old-takeover", {
      kind: "click",
      at: { x: 1280, y: 800 },
      button: "left",
      count: 1,
    });
    view.rerender(
      <Stage
        cell={ready}
        api={api}
        reconnects={0}
        listed={[CELL]}
        manual={{ ...manual, requestId: "current-takeover", button: "right" }}
      />,
    );
    fireEvent.keyDown(surface, { key: "a" });
    fireEvent.keyDown(surface, { key: "Tab" });
    fireEvent.keyDown(surface, { key: "Process", isComposing: true });
    expect(input).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(surface, { key: "ArrowLeft" });
    expect(input).toHaveBeenLastCalledWith("current-takeover", { kind: "key", combo: ["left"] });
    fireEvent.click(surface, { detail: 1, clientX: 340, clientY: 330 });
    expect(input).toHaveBeenLastCalledWith("current-takeover", {
      kind: "click",
      at: { x: 1280, y: 800 },
      button: "right",
      count: 1,
    });
    view.rerender(
      <Stage
        cell={{ ...ready, paused: true }}
        api={api}
        reconnects={0}
        listed={[CELL]}
        manual={manual}
      />,
    );
    expect(surface.disabled).toBe(true);
    fireEvent.click(surface, { detail: 1, clientX: 340, clientY: 330 });
    fireEvent.keyDown(surface, { key: "Enter" });
    expect(input).toHaveBeenCalledTimes(3);
    expect(client()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(1);
    view.unmount();
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
    vi.restoreAllMocks();
  });

  it("loads the client, out of sight and inert, from the path of a ticket it mints", async () => {
    const { api, calls } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(`${ticketPath(1)}#shared`));
    expect(client()?.hasAttribute("inert")).toBe(true);
    expect(calls).toEqual([`POST /api/cells/${CELL}/stream-ticket`]);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]?.sent[0]?.message.type).toBe("init");
  });

  it("follows the browser ticket and refuses a stale response after switching back to desktop", async () => {
    const browserId = "01JXYZ0000000000000000ABCE";
    let finish: (response: Response) => void = () => {};
    const calls: string[] = [];
    const api = createApi("a".repeat(43), {
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname;
        calls.push(path);
        if (path.endsWith("browser-stream-ticket"))
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        return new Response(JSON.stringify({ path: ticketPath(1) }));
      },
    });
    const selection = {
      screen: "browser" as const,
      cellId: browserId,
      revision: 2,
      geometry: { w: 2560, h: 1600, scale: 2 as const },
    };
    const browserCell = { ...ready, id: browserId };
    const ui = render(
      <Stage
        cell={browserCell}
        parentId={CELL}
        selection={selection}
        api={api}
        reconnects={0}
        listed={[CELL]}
      />,
    );
    expect(client()).toBeNull();
    expect(calls).toEqual([`/api/cells/${CELL}/browser-stream-ticket`]);
    ui.rerender(
      <Stage
        cell={ready}
        parentId={CELL}
        selection={{ ...selection, screen: "desktop", cellId: CELL, revision: 3 }}
        api={api}
        reconnects={0}
        listed={[CELL]}
      />,
    );
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(`${ticketPath(1)}#shared`));
    await act(async () =>
      finish(
        new Response(
          JSON.stringify({
            cellId: browserId,
            path: `/cells/${browserId}/browser/${"B".repeat(22)}/`,
          }),
        ),
      ),
    );
    expect(client()?.getAttribute("src")).toBe(`${ticketPath(1)}#shared`);
  });

  it.each(["browser", "wrong-id", "desktop-path"])(
    "checks the physical owner and surface of a %s ticket",
    async (kind) => {
      const browserId = "01JXYZ0000000000000000ABCE",
        path = `/cells/${browserId}/${kind === "desktop-path" ? "desktop" : "browser"}/${"B".repeat(22)}/`;
      const api = createApi("a".repeat(43), {
        fetchImpl: async () =>
          new Response(JSON.stringify({ cellId: kind === "wrong-id" ? CELL : browserId, path })),
      });
      const selection = {
        screen: "browser" as const,
        cellId: browserId,
        revision: 1,
        geometry: { w: 2560, h: 1600, scale: 2 as const },
      };
      render(
        <Stage
          cell={{ ...ready, id: browserId }}
          parentId={CELL}
          selection={selection}
          api={api}
          reconnects={0}
          listed={[CELL]}
        />,
      );
      await act(async () => {});
      expect(client()?.getAttribute("src") ?? null).toBe(
        kind === "browser" ? `${path}#shared` : null,
      );
      expect(FakeWorker.instances[0]?.sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: { type: "view", view: { selection } } }),
        ]),
      );
    },
  );

  it("drops what the client stored under the cell's earlier tickets when it mints", async () => {
    const page = (path: string) => `${window.location.origin}${path}`.replace(/[^\w.-]/g, "_");
    const old = `${page(`/cells/${CELL}/desktop/${"O".repeat(22)}/`)}_stream_mode`;
    window.localStorage.setItem(old, "webrtc");
    window.localStorage.setItem("localdot.token", "kept");
    const { api } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    expect(window.localStorage.getItem(old)).toBeNull();
    expect(window.localStorage.getItem("localdot.token")).toBe("kept");
  });

  it("drops what the client stored for a cell the daemon no longer lists", async () => {
    const page = (path: string) => `${window.location.origin}${path}`.replace(/[^\w.-]/g, "_");
    const gone = `${page(`/cells/01JXYZ0000000000000000GONE/desktop/${"O".repeat(22)}/`)}_stream_mode`;
    window.localStorage.setItem(gone, "websockets");
    const { api } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    expect(window.localStorage.getItem(gone)).toBeNull();
  });

  it("mints again and loads a fresh client when the daemon socket reconnects", async () => {
    const { api, calls } = daemon();
    const view = render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    const before = client();
    view.rerender(<Stage cell={ready} api={api} reconnects={1} listed={[CELL]} />);
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(`${ticketPath(2)}#shared`));
    expect(client()).not.toBe(before);
    expect(calls).toHaveLength(2);
  });

  it("mints again after 10 s without a video element in the client, and never while it has one", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    const { api, calls } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    const before = client() as HTMLIFrameElement;
    playInClient(before, "t1");
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(calls).toHaveLength(1);
    before.contentDocument?.getElementById("videoStream")?.remove();
    await act(async () => vi.advanceTimersByTime(9_000));
    expect(calls).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1_500));
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(`${ticketPath(2)}#shared`));
    expect(client()).not.toBe(before);
  });

  it("hands each new track of the client to the render worker once, seeded with its current frame", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    const { api } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    const frames = () => FakeWorker.instances[0]?.sent.filter((s) => s.message.type === "frames");
    playInClient(client() as HTMLIFrameElement, "t1");
    await act(async () => vi.advanceTimersByTime(1_000));
    await waitFor(() => expect(frames()).toHaveLength(1));
    const [sent] = frames() ?? [];
    const first = sent?.message.first as { source?: unknown } | undefined;
    expect(first).toBeInstanceOf(VideoFrame);
    expect(first?.source).toBe(client()?.contentDocument?.getElementById("videoStream"));
    expect(sent?.transfer).toEqual([sent?.message.readable, first]);
    playInClient(client() as HTMLIFrameElement, "t2");
    await act(async () => vi.advanceTimersByTime(1_000));
    await waitFor(() => expect(frames()).toHaveLength(2));
  });

  it("refreshes a stalled tap only when the client decodes another frame", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    const { api, calls } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    const before = client() as HTMLIFrameElement;
    playInClient(before, "t1");
    let decoded = 10;
    const video = before.contentDocument?.getElementById("videoStream");
    Object.defineProperty(video, "getVideoPlaybackQuality", {
      value: () => ({ totalVideoFrames: decoded }),
    });
    await act(async () => vi.advanceTimersByTime(1_000));
    const worker = FakeWorker.instances[0];
    const sourceId = worker?.sent.findLast((row) => row.message.type === "frames")?.message
      .sourceId;
    act(() =>
      worker?.onmessage?.({
        data: {
          type: "stats",
          sourceId,
          stats: { presented: 1, fps: 30, lastFrameAt: 1, width: 1280, height: 800 },
        },
      }),
    );
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(calls).toHaveLength(1); // A still desktop has no new frames to present.
    decoded += 1;
    await act(async () => vi.advanceTimersByTime(250));
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(`${ticketPath(2)}#shared`));
    expect(client()).not.toBe(before);
  });

  it("refreshes after suspended timers resume even without a browser lifecycle event", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    const { api, calls } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    playInClient(client() as HTMLIFrameElement, "t1");
    await act(async () => vi.advanceTimersByTime(1000));
    vi.setSystemTime(Date.now() + 30_000);
    await act(async () => vi.advanceTimersByTime(250));
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(`${ticketPath(2)}#shared`));
    expect(calls).toHaveLength(2);
  });

  it("removes the client and stops the frames when the cell leaves ready", async () => {
    const { api } = daemon();
    const view = render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    view.rerender(
      <Stage cell={{ ...ready, state: "stopping" }} api={api} reconnects={0} listed={[CELL]} />,
    );
    expect(client()).toBeNull();
    expect(FakeWorker.instances[0]?.sent.at(-1)?.message.type).toBe("stop");
  });

  it("veils the stage while the stream is stalled", () => {
    const { api } = daemon();
    const stalled = { ...ready, stream: { ...ready.stream, connection: "stalled" as const } };
    const view = render(<Stage cell={stalled} api={api} reconnects={0} listed={[CELL]} />);
    expect(document.querySelector(".stage-veil.on")?.textContent).toBe("Reconnecting…");
    const live = { ...ready, stream: { ...ready.stream, connection: "live" as const } };
    view.rerender(<Stage cell={live} api={api} reconnects={0} listed={[CELL]} />);
    expect(document.querySelector(".stage-veil.on")).toBeNull();
  });

  it("detaches a frozen computer, suppresses reconnects, and mints a new ticket only after Resume", async () => {
    const { api, calls } = daemon();
    const view = render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    const paused = {
      ...ready,
      paused: true as const,
      stream: { ...ready.stream, connection: "stalled" as const },
    };
    view.rerender(<Stage cell={paused} api={api} reconnects={0} listed={[CELL]} />);
    expect(client()).toBeNull();
    expect(document.querySelector(".stage-veil.on")).toBeNull();
    expect(
      FakeWorker.instances[0]?.sent
        .filter((s) => s.message.type === "view")
        .map((s) => s.message.view),
    ).toContainEqual({ freeze: true, zoom: 1 });
    view.rerender(<Stage cell={paused} api={api} reconnects={1} listed={[CELL]} />);
    fireEvent(document, new Event("resume"));
    expect(calls).toHaveLength(1);
    view.rerender(<Stage cell={ready} api={api} reconnects={1} listed={[CELL]} />);
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(`${ticketPath(2)}#shared`));
    expect(calls).toHaveLength(2);
  });
  it("cancels a late ticket arriving after pause and mints a fresh one on resume", async () => {
    const paused = { ...ready, paused: true as const };
    const json = (body: unknown) => new Response(JSON.stringify(body));
    const late = Promise.withResolvers<Response>();
    let tickets = 0;
    const api = createApi("fake-token", {
      fetchImpl: async () => {
        tickets++;
        return tickets === 1 ? late.promise : json({ path: ticketPath(tickets) });
      },
    });
    const view = render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    try {
      await waitFor(() => expect(tickets).toBe(1));
      view.rerender(<Stage cell={paused} api={api} reconnects={0} listed={[CELL]} />);
      await act(async () => late.resolve(json({ path: ticketPath(1) })));
      expect(client()).toBeNull();
      expect(FakeWorker.instances[0]?.sent.some((s) => s.message.type === "stop")).toBe(true);
      view.rerender(<Stage cell={paused} api={api} reconnects={1} listed={[CELL]} />);
      fireEvent(document, new Event("resume"));
      fireEvent(document, new Event("visibilitychange"));
      expect(tickets).toBe(1);
      view.rerender(<Stage cell={ready} api={api} reconnects={1} listed={[CELL]} />);
      await waitFor(() => expect(client()?.getAttribute("src")).toBe(`${ticketPath(2)}#shared`));
      expect(tickets).toBe(2);
    } finally {
      view.unmount();
    }
  });
});
