// @vitest-environment jsdom

import type { ManualStreamInput } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { FakeWorker, fakeChromium, playInClient } from "../testing/fake-chromium.ts";
import {
  closeStreams,
  FIRST_FRAME_MS,
  HELD_AFTER_MS,
  KEEP_MS,
  STALE_MS,
  TAP_STALL_MS,
} from "./live-stream.ts";
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
const clients = () => [...document.querySelectorAll<HTMLIFrameElement>("iframe.desktop-frame")];
const fakeTimers = () =>
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    shouldAdvanceTime: true,
  });

afterEach(() => {
  cleanup();
  closeStreams();
});

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

  // The daemon mints ticket n for the n-th request, or, like the real one, keeps the live one.
  function daemon(keeps = false) {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      const path = ticketPath(keeps ? 1 : calls.length);
      return new Response(JSON.stringify({ ticket: path.split("/")[4], path }), { status: 200 });
    }) as typeof fetch;
    return { api: createApi("a".repeat(43), { fetchImpl }), calls };
  }
  const worker = () => FakeWorker.instances[0];
  const framesSent = () => worker()?.sent.filter((row) => row.message.type === "frames") ?? [];
  const stops = () => worker()?.sent.filter((row) => row.message.type === "stop") ?? [];
  // The worker reports a presented frame of the newest tap.
  const present = () =>
    act(() =>
      worker()?.onmessage?.({
        data: {
          type: "stats",
          sourceId: framesSent().at(-1)?.message.sourceId,
          stats: { presented: 1, fps: 30, lastFrameAt: 1, width: 2560, height: 1600 },
        },
      }),
    );
  async function streaming(api: ReturnType<typeof daemon>["api"], props = {}) {
    const view = render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} {...props} />);
    await waitFor(() => expect(client()).not.toBeNull());
    playInClient(client() as HTMLIFrameElement, "t1");
    await waitFor(() => expect(framesSent()).toHaveLength(1));
    present();
    return view;
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

  it("keeps the live client through a visit to Replay, and closes it a minute later", async () => {
    fakeTimers();
    const { api, calls } = daemon();
    const stage = createRef<StageHandle>();
    const at = (mode: "live" | "replay") => (
      <Stage ref={stage} mode={mode} cell={ready} api={api} reconnects={0} listed={[CELL]} />
    );
    const view = render(at("live"));
    await waitFor(() => expect(client()).not.toBeNull());
    const first = client();
    playInClient(first as HTMLIFrameElement, "replay-switch-track");
    await waitFor(() => expect(framesSent()).toHaveLength(1));
    view.rerender(at("replay"));
    expect(client()).toBe(first);
    expect(worker()?.sent.at(-1)?.message.type).not.toBe("frames");
    view.rerender(at("live"));
    // Back in Watch, the same client's frames are taken again, seeded with the frame it shows.
    await waitFor(() => expect(framesSent()).toHaveLength(2));
    expect(client()).toBe(first);
    expect(calls).toHaveLength(1);
    view.rerender(at("replay"));
    await act(async () => vi.advanceTimersByTime(KEEP_MS));
    expect(client()).toBeNull();
    view.rerender(at("live"));
    await waitFor(() => expect(client()).not.toBeNull());
    expect(calls).toHaveLength(2);
    expect(client()?.getAttribute("src")).toBe(`${ticketPath(2)}#shared`);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("streams the pointer, wheel and every key through the real backing viewport while the computer shows", async () => {
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
    const send = vi.fn<(input: ManualStreamInput) => void>();
    const typing = vi.fn<(typing: boolean) => void>();
    const manual = {
      enabled: true,
      screen: { w: 2560, h: 1600 },
      pointer: "click" as const,
      send,
      onTyping: typing,
    };
    const stage = createRef<StageHandle>();
    const view = render(
      <Stage ref={stage} cell={ready} api={api} reconnects={0} listed={[CELL]} manual={manual} />,
    );
    const surface = document.querySelector(".manual-surface") as HTMLElement;
    const keys = screen.getByLabelText<HTMLTextAreaElement>("Type on the computer");
    const mouse = (x: number, y: number, button = 0) => ({
      pointerId: 1,
      pointerType: "mouse",
      button,
      clientX: x,
      clientY: y,
    });
    expect(keys.readOnly).toBe(true); // A ticket alone does not show the computer.
    expect(keys.getAttribute("aria-disabled")).toBe("true");
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
    await waitFor(() => expect(keys.readOnly).toBe(false));
    expect(surface.hasAttribute("data-live")).toBe(true);

    fireEvent.pointerDown(surface, mouse(340, 50)); // Letterboxing.
    fireEvent.pointerUp(surface, mouse(340, 50));
    expect(send).not.toHaveBeenCalled();
    fireEvent.pointerDown(surface, mouse(340, 330));
    expect(document.activeElement).toBe(keys);
    expect(typing).toHaveBeenLastCalledWith(true);
    fireEvent.pointerMove(surface, mouse(360, 330));
    fireEvent.pointerMove(surface, mouse(700, 330)); // Past the edge: the drag follows it.
    fireEvent.pointerUp(surface, mouse(700, 330));
    fireEvent.pointerDown(surface, mouse(340, 330, 2));
    fireEvent.pointerUp(surface, mouse(340, 330, 2));
    expect(send.mock.calls.map(([input]) => input)).toEqual([
      { kind: "down", at: { x: 1280, y: 800 }, button: "left" },
      { kind: "move", at: { x: 1360, y: 800 } },
      { kind: "move", at: { x: 2559, y: 800 } },
      { kind: "up", at: { x: 2559, y: 800 }, button: "left" },
      { kind: "down", at: { x: 1280, y: 800 }, button: "right" },
      { kind: "up", at: { x: 1280, y: 800 }, button: "right" },
    ]);
    send.mockClear();

    fireEvent.wheel(surface, { deltaY: 120, clientX: 340, clientY: 330 });
    fireEvent.wheel(surface, { deltaY: 30, deltaX: 0, clientX: 340, clientY: 330, ctrlKey: true });
    expect(send.mock.calls.map(([input]) => input)).toEqual([
      { kind: "scroll", at: { x: 1280, y: 800 }, dx: 0, dy: 2 },
      { kind: "scroll", at: { x: 1280, y: 800 }, dx: 0, dy: 1, mods: ["ctrl"] },
    ]);
    send.mockClear();

    // The field holds only a pad of zero-width spaces between keys, never what was typed.
    const pad = keys.value;
    expect(pad).toMatch(/^\u200b+$/);
    fireEvent.input(keys, { target: { value: `${pad}u` } });
    expect(keys.value).toBe(pad);
    fireEvent.input(keys, { target: { value: `${pad}s` } });
    expect(fireEvent.keyDown(keys, { key: "Tab" })).toBe(false);
    fireEvent.compositionStart(keys);
    fireEvent.input(keys, { target: { value: `${pad}ni` } });
    fireEvent.compositionEnd(keys, { data: "你" });
    fireEvent.input(keys, { target: { value: `${pad}你` } });
    expect(keys.value).toBe(pad);
    fireEvent.paste(keys, { clipboardData: { getData: () => "pass word!" } });
    expect(fireEvent.keyDown(keys, { key: "Backspace" })).toBe(false);
    // A phone keyboard's Backspace deletes from the pad instead.
    fireEvent.input(keys, { target: { value: pad.slice(1) } });
    expect(keys.value).toBe(pad);
    expect(send.mock.calls.map(([input]) => input)).toEqual([
      { kind: "text", text: "u" },
      { kind: "text", text: "s" },
      { kind: "key", combo: ["tab"] },
      { kind: "text", text: "你" },
      { kind: "text", text: "pass word!" },
      { kind: "key", combo: ["backspace"] },
      { kind: "key", combo: ["backspace"] },
    ]);
    send.mockClear();

    fireEvent.keyDown(keys, { key: "Escape" });
    fireEvent.keyDown(keys, { key: "Escape" });
    expect(send.mock.calls.map(([input]) => input)).toEqual([{ kind: "key", combo: ["esc"] }]);
    expect(document.activeElement).not.toBe(keys);
    expect(typing).toHaveBeenLastCalledWith(false);
    act(() => stage.current?.keyboard(true));
    expect(document.activeElement).toBe(keys);

    view.rerender(
      <Stage
        ref={stage}
        cell={ready}
        api={api}
        reconnects={0}
        listed={[CELL]}
        manual={{ ...manual, pointer: "right" }}
      />,
    );
    send.mockClear();
    const finger = { ...mouse(340, 330), pointerType: "touch" };
    fireEvent.pointerDown(surface, finger);
    fireEvent.pointerMove(surface, { ...finger, clientX: 342 }); // Within a finger's slop.
    fireEvent.pointerUp(surface, { ...finger, clientX: 342 });
    // So does a mouse that shakes a pixel while it presses.
    fireEvent.pointerDown(surface, mouse(340, 330));
    fireEvent.pointerMove(surface, mouse(341, 331));
    fireEvent.pointerUp(surface, mouse(341, 331));
    expect(send.mock.calls.map(([input]) => input)).toEqual([
      { kind: "click", at: { x: 1280, y: 800 }, button: "right", count: 1 },
      { kind: "click", at: { x: 1280, y: 800 }, button: "right", count: 1 },
    ]);

    // In Click mode a finger that wobbles while it taps lets go where it pressed.
    view.rerender(
      <Stage ref={stage} cell={ready} api={api} reconnects={0} listed={[CELL]} manual={manual} />,
    );
    send.mockClear();
    fireEvent.pointerDown(surface, finger);
    fireEvent.pointerMove(surface, { ...finger, clientX: 342, clientY: 331 });
    fireEvent.pointerUp(surface, { ...finger, clientX: 342, clientY: 331 });
    expect(send.mock.calls.map(([input]) => input)).toEqual([
      { kind: "down", at: { x: 1280, y: 800 }, button: "left" },
      { kind: "up", at: { x: 1280, y: 800 }, button: "left" },
    ]);

    view.rerender(
      <Stage
        ref={stage}
        cell={{ ...ready, paused: true }}
        api={api}
        reconnects={0}
        listed={[CELL]}
        manual={manual}
      />,
    );
    send.mockClear();
    expect(keys.readOnly).toBe(true);
    fireEvent.pointerDown(surface, mouse(340, 330));
    fireEvent.keyDown(keys, { key: "Enter" });
    fireEvent.input(keys, { target: { value: "late" } });
    expect(send).not.toHaveBeenCalled();
    expect(client()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(1);
    view.unmount();
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

  it("loads a fresh client when a reopened status socket brings a new ticket", async () => {
    const { api, calls } = daemon();
    const view = render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    const before = client();
    view.rerender(<Stage cell={ready} api={api} reconnects={1} listed={[CELL]} />);
    await waitFor(() => expect(client()?.getAttribute("src")).toBe(`${ticketPath(2)}#shared`));
    expect(client()).not.toBe(before);
    expect(clients()).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("keeps its client when a reopened status socket finds the same ticket", async () => {
    const { api, calls } = daemon(true);
    const view = await streaming(api);
    const before = client();
    view.rerender(<Stage cell={ready} api={api} reconnects={1} listed={[CELL]} />);
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => {});
    expect(clients()).toHaveLength(1);
    expect(client()).toBe(before);
    expect(framesSent()).toHaveLength(1);
    expect(stops()).toHaveLength(1); // The mount's own.
  });

  it("keeps its client and frames when the agent selects the same screen again", async () => {
    const { api, calls } = daemon();
    const selection = (revision: number) => ({
      screen: "desktop" as const,
      cellId: CELL,
      revision,
      geometry: { w: 2560, h: 1600, scale: 2 as const },
    });
    const view = await streaming(api, { selection: selection(0) });
    const before = client();
    // A task starting, the agent switching screens and a hand-back each publish a new revision.
    for (const revision of [1, 2, 3])
      view.rerender(
        <Stage
          cell={ready}
          selection={selection(revision)}
          api={api}
          reconnects={0}
          listed={[CELL]}
        />,
      );
    await act(async () => {});
    expect(clients()).toHaveLength(1);
    expect(client()).toBe(before);
    expect(calls).toHaveLength(1);
    expect(framesSent()).toHaveLength(1);
    expect(stops()).toHaveLength(1);
  });

  it("keeps its client, worker and canvas when the stage remounts in another container", async () => {
    const { api, calls } = daemon();
    const first = await streaming(api);
    const before = client();
    const canvas = document.querySelector("canvas.stage-canvas");
    first.unmount();
    const elsewhere = render(
      <div className="focus">
        <Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />
      </div>,
    );
    expect(elsewhere.container.querySelector(".focus > canvas.stage-canvas")).toBe(canvas);
    expect(clients()).toHaveLength(1);
    expect(client()).toBe(before);
    // The new stage takes the same client's frames at once, seeded with the frame it shows.
    expect(framesSent()).toHaveLength(2);
    expect((framesSent().at(-1)?.message.first as { source?: unknown })?.source).toBe(
      before?.contentDocument?.getElementById("videoStream"),
    );
    expect(calls).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker()?.terminated).toBe(false);
  });

  it("closes the worker a minute after its last stage goes", async () => {
    fakeTimers();
    const { api } = daemon();
    const view = await streaming(api);
    view.unmount();
    await act(async () => vi.advanceTimersByTime(KEEP_MS - 1000));
    expect(worker()?.terminated).toBe(false);
    expect(clients()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(worker()?.terminated).toBe(true);
    expect(clients()).toHaveLength(0);
  });

  it("keeps the desktop's client while the browser shows, and switches back to it at once", async () => {
    const browserId = "01JXYZ0000000000000000ABCE";
    const calls: string[] = [];
    const api = createApi("a".repeat(43), {
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname;
        calls.push(path);
        return new Response(
          JSON.stringify(
            path.endsWith("browser-stream-ticket")
              ? { cellId: browserId, path: `/cells/${browserId}/browser/${"B".repeat(22)}/` }
              : { path: ticketPath(1) },
          ),
        );
      },
    });
    const desktop = {
      screen: "desktop" as const,
      cellId: CELL,
      revision: 1,
      geometry: { w: 2560, h: 1600, scale: 2 as const },
    };
    const browser = { ...desktop, screen: "browser" as const, cellId: browserId, revision: 2 };
    const view = await streaming(api, { selection: desktop, parentId: CELL });
    const desktopClient = client();
    view.rerender(
      <Stage
        cell={{ ...ready, id: browserId }}
        parentId={CELL}
        selection={browser}
        api={api}
        reconnects={0}
        listed={[CELL]}
      />,
    );
    await waitFor(() => expect(clients()).toHaveLength(2));
    view.rerender(
      <Stage
        cell={ready}
        parentId={CELL}
        selection={{ ...desktop, revision: 3 }}
        api={api}
        reconnects={0}
        listed={[CELL]}
      />,
    );
    await waitFor(() => expect(framesSent()).toHaveLength(2));
    expect(clients()[0]).toBe(desktopClient);
    expect(calls.filter((path) => path.endsWith("/stream-ticket"))).toHaveLength(1);
  });

  it("takes the frames afresh, without a new client, when the page is shown again", async () => {
    const { api, calls } = daemon();
    await streaming(api);
    const before = client();
    fireEvent(document, new Event("visibilitychange"));
    expect(framesSent()).toHaveLength(2);
    expect(clients()).toHaveLength(1);
    expect(client()).toBe(before);
    expect(calls).toHaveLength(1);
  });

  it("keeps a thawed page's client showing until its fresh replacement shows a frame", async () => {
    const { api, calls } = daemon();
    await streaming(api);
    const before = client() as HTMLIFrameElement;
    fireEvent(document, new Event("resume"));
    await waitFor(() => expect(clients()).toHaveLength(2));
    expect(calls).toHaveLength(2);
    const fresh = clients()[1] as HTMLIFrameElement;
    expect(fresh.getAttribute("src")).toBe(`${ticketPath(2)}#shared`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(clients()).toHaveLength(2);
    expect(clients()[0]).toBe(before);
    playInClient(fresh, "t2");
    await waitFor(() => expect(clients()).toHaveLength(1));
    expect(client()).toBe(fresh);
    await waitFor(() => expect(framesSent()).toHaveLength(2));
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

  it("takes a stalled tap again, then replaces the client only if that does not help", async () => {
    fakeTimers();
    const { api, calls } = daemon();
    await streaming(api);
    const before = client() as HTMLIFrameElement;
    let decoded = 10;
    Object.defineProperty(
      before.contentDocument?.getElementById("videoStream"),
      "getVideoPlaybackQuality",
      {
        value: () => ({ totalVideoFrames: decoded }),
      },
    );
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(calls).toHaveLength(1); // A still desktop has no new frames to present.
    expect(framesSent()).toHaveLength(1);
    decoded += 1;
    await act(async () => vi.advanceTimersByTime(250));
    expect(framesSent()).toHaveLength(2);
    expect(calls).toHaveLength(1);
    for (let t = 0; t < TAP_STALL_MS + STALE_MS; t += 250) {
      decoded += 1;
      await act(async () => vi.advanceTimersByTime(250));
    }
    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => expect(clients()).toHaveLength(2));
    expect(clients()[0]).toBe(before);
  });

  it("replaces the client after suspended timers resume, keeping the old one until then", async () => {
    fakeTimers();
    const { api, calls } = daemon();
    await streaming(api);
    const before = client();
    vi.setSystemTime(Date.now() + 30_000);
    await act(async () => vi.advanceTimersByTime(250));
    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => expect(clients()).toHaveLength(2));
    expect(clients()[0]).toBe(before);
    expect(clients()[1]?.getAttribute("src")).toBe(`${ticketPath(2)}#shared`);
  });

  it("asks the encoder for a key frame when a fresh tap shows nothing", async () => {
    fakeTimers();
    const { api } = daemon();
    render(<Stage cell={ready} api={api} reconnects={0} listed={[CELL]} />);
    await waitFor(() => expect(client()).not.toBeNull());
    const frame = client() as HTMLIFrameElement;
    const send = vi.fn();
    Object.assign(frame.contentWindow as object, { selkiesTransport: { readyState: 1, send } });
    playInClient(frame, "t1");
    await act(async () => vi.advanceTimersByTime(250));
    expect(framesSent()).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(FIRST_FRAME_MS + 250));
    expect(send).toHaveBeenCalledWith("REQUEST_KEYFRAME");
    present();
    send.mockClear();
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(send).not.toHaveBeenCalled();
  });

  it("holds its last picture while the client reconnects, and says so only after a second", async () => {
    fakeTimers();
    const { api } = daemon();
    const onPicture = vi.fn();
    await streaming(api, { onPicture });
    expect(onPicture).toHaveBeenLastCalledWith("live");
    const frame = client() as HTMLIFrameElement;
    // Selkies reloads its page to reconnect: its video goes, then comes back with a new track.
    frame.contentDocument?.getElementById("videoStream")?.remove();
    await act(async () => vi.advanceTimersByTime(HELD_AFTER_MS - 250));
    expect(onPicture).toHaveBeenLastCalledWith("live");
    await act(async () => vi.advanceTimersByTime(500));
    expect(onPicture).toHaveBeenLastCalledWith("held");
    expect(document.querySelector(".stage-veil")).toBeNull();
    expect(stops()).toHaveLength(1);
    playInClient(frame, "t2");
    await act(async () => vi.advanceTimersByTime(250));
    expect(framesSent()).toHaveLength(2);
    present();
    expect(onPicture).toHaveBeenLastCalledWith("live");
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

  it("keeps the picture unveiled while the stream is stalled", () => {
    const { api } = daemon();
    const stalled = { ...ready, stream: { ...ready.stream, connection: "stalled" as const } };
    render(<Stage cell={stalled} api={api} reconnects={0} listed={[CELL]} />);
    expect(document.querySelector(".stage-veil")).toBeNull();
    expect(
      worker()
        ?.sent.filter((row) => row.message.type === "view")
        .map((row) => row.message.view),
    ).toContainEqual({ freeze: true, zoom: 1 });
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
