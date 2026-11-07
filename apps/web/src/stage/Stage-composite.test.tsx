// @vitest-environment jsdom
import type { ManualStreamInput, ScreenSelectionSnapshot } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { FakeWorker, fakeChromium, playInClient } from "../testing/fake-chromium.ts";
import { closeStreams } from "./live-stream.ts";
import { Stage } from "./Stage.tsx";
import { DOCK_ASK_MS } from "./useDockCovered.ts";
import type { StageFront } from "./useStageFront.ts";
import { UNDER_AWAKE_MS, UNDER_REFRESH_MS } from "./useUnderDesktop.ts";

const DESKTOP = "01JXYZ0000000000000000AAAA";
const BROWSER = "01JXYZ0000000000000000BBBB";
const cell = (id: string): CellSummary => ({
  id,
  state: "ready",
  scale: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
});
const geometry = { w: 2560, h: 1600, scale: 2 as const };
const onBrowser: ScreenSelectionSnapshot = {
  screen: "browser",
  cellId: BROWSER,
  geometry,
  revision: 2,
};
const onDesktop: ScreenSelectionSnapshot = {
  screen: "desktop",
  cellId: DESKTOP,
  geometry,
  revision: 3,
};

const frames = (of: "desktop" | "browser") =>
  [...document.querySelectorAll<HTMLIFrameElement>("iframe.desktop-frame")].filter((frame) =>
    frame.src.includes(`/${of}/`),
  );
const worker = () => FakeWorker.instances[0];
const sent = (type: string) =>
  worker()
    ?.sent.filter((row) => row.message.type === type)
    .map((row) => row.message) ?? [];
const fakeTimers = () =>
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    shouldAdvanceTime: true,
  });

// `dock.covered`: what the computer says of its dock; null, that it can't say.
function daemon(dock: { covered: boolean | null } = { covered: false }) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    if (String(input).endsWith("/dock"))
      return dock.covered === null
        ? new Response("the computer's windows can't be read", { status: 502 })
        : Response.json({ covered: dock.covered });
    const browser = String(input).includes("browser-stream-ticket");
    const id = browser ? BROWSER : DESKTOP;
    const path = `/cells/${id}/${browser ? "browser" : "desktop"}/${"T".repeat(22)}/`;
    return Response.json({ ticket: "T", cellId: id, path });
  });
  return { api: createApi("a".repeat(43), { fetchImpl }), fetchImpl };
}

describe("the stage's one screen", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = fakeChromium();
  });
  afterEach(() => {
    cleanup();
    closeStreams();
    vi.useRealTimers();
    vi.restoreAllMocks();
    restore();
  });

  const props = (api: ReturnType<typeof daemon>["api"]) => ({
    api,
    reconnects: 0,
    listed: [DESKTOP],
    parentId: DESKTOP,
    parent: cell(DESKTOP),
  });
  const underStats = (presented = 1) =>
    act(() =>
      worker()?.onmessage?.({
        data: {
          type: "stats",
          under: true,
          sourceId: sent("frames").findLast((message) => message.under)?.sourceId,
          stats: { presented, fps: 30, lastFrameAt: 1, width: 2560, height: 1600 },
        },
      }),
    );
  const mainStats = () =>
    act(() =>
      worker()?.onmessage?.({
        data: {
          type: "stats",
          sourceId: sent("frames").findLast((message) => !message.under)?.sourceId,
          stats: { presented: 1, fps: 30, lastFrameAt: 1, width: 2560, height: 1600 },
        },
      }),
    );
  async function bothOn(api: ReturnType<typeof daemon>["api"], extra = {}) {
    const view = render(
      <Stage {...props(api)} cell={cell(BROWSER)} selection={onBrowser} {...extra} />,
    );
    await waitFor(() => expect(frames("browser")).toHaveLength(1));
    await waitFor(() => expect(frames("desktop")).toHaveLength(1));
    const send = vi.fn();
    const desktop = frames("desktop")[0] as HTMLIFrameElement;
    Object.assign(desktop.contentWindow as object, { selkiesTransport: { readyState: 1, send } });
    playInClient(frames("browser")[0] as HTMLIFrameElement, "browser-track");
    playInClient(desktop, "desktop-track");
    await waitFor(() => expect(sent("frames").filter((m) => m.under)).toHaveLength(1));
    await waitFor(() => expect(sent("frames").filter((m) => !m.under)).toHaveLength(1));
    return { view, send };
  }

  it("tells the worker which screen is in front, on the desktop's own size", async () => {
    const { api } = daemon();
    render(<Stage {...props(api)} cell={cell(DESKTOP)} selection={onDesktop} />);
    await waitFor(() => expect(sent("view").some((message) => message.view)).toBe(true));
    expect(
      sent("view").findLast(
        (message) => (message.view as { composite?: unknown }).composite !== undefined,
      )?.view,
    ).toEqual({ composite: { front: "desktop", desktop: { w: 2560, h: 1600 } } });
    // With the desktop in front there is one stream.
    await waitFor(() => expect(frames("desktop")).toHaveLength(1));
    expect(frames("browser")).toHaveLength(0);
  });

  const frontOf = (over: Partial<StageFront>): StageFront => ({
    screen: "desktop",
    dot: "desktop",
    browser: undefined,
    problem: null,
    pick: vi.fn(),
    route: (input) => input,
    ...over,
  });

  it("puts the web browser in the dock, as one of the desktop's apps, and no switch by the picture", async () => {
    const { api } = daemon();
    const front = frontOf({});
    render(
      <Stage
        {...props(api)}
        cell={cell(DESKTOP)}
        selection={onDesktop}
        front={front}
        browserEngine="chrome"
      />,
    );
    const item = await screen.findByRole("button", { name: "Show the web browser" });
    await waitFor(() =>
      expect(item.closest(".browser-dock")?.hasAttribute("data-shown")).toBe(true),
    );
    expect(item.querySelector(".browser-icon")?.getAttribute("data-engine")).toBe("chrome");
    expect(screen.queryByRole("group", { name: /window$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(desktop|web browser)$/i })).toBeNull();
    expect(screen.queryByText("Web browser")).toBeNull();
    fireEvent.click(item);
    expect(front.pick).toHaveBeenCalledWith("browser");
  });

  describe("its dock item, as the desktop's dock", () => {
    const shown = () => document.querySelector(".browser-dock")?.hasAttribute("data-shown");
    const edge = () => document.querySelector(".browser-dock-edge") as HTMLElement;
    const desktopFront = (api: ReturnType<typeof daemon>["api"]) =>
      render(
        <Stage {...props(api)} cell={cell(DESKTOP)} selection={onDesktop} front={frontOf({})} />,
      );
    const asked = (fetchImpl: ReturnType<typeof daemon>["fetchImpl"]) =>
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith(`/api/cells/${DESKTOP}/dock`))
        .length;

    it("stays up over an empty dock, and out of the way of a window over it", async () => {
      const dock = { covered: false as boolean | null };
      const { api, fetchImpl } = daemon(dock);
      fakeTimers();
      desktopFront(api);
      await waitFor(() => expect(shown()).toBe(true));
      expect(edge()).toBeNull();
      dock.covered = true;
      await act(() => vi.advanceTimersByTimeAsync(DOCK_ASK_MS + 10));
      await waitFor(() => expect(shown()).toBe(false));
      expect(asked(fetchImpl)).toBeGreaterThanOrEqual(2);
      // The pointer at the bottom edge brings it back, and it goes once the pointer leaves.
      fireEvent.pointerEnter(edge(), { pointerType: "mouse" });
      expect(shown()).toBe(true);
      fireEvent.pointerLeave(edge(), { pointerType: "mouse" });
      fireEvent.pointerEnter(document.querySelector(".browser-dock") as HTMLElement, {
        pointerType: "mouse",
      });
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(shown()).toBe(true);
      fireEvent.pointerLeave(document.querySelector(".browser-dock") as HTMLElement, {
        pointerType: "mouse",
      });
      await act(() => vi.advanceTimersByTimeAsync(400));
      expect(shown()).toBe(false);
      // A tap there brings it back for a moment.
      fireEvent.pointerDown(edge(), { pointerType: "touch" });
      expect(shown()).toBe(true);
      await act(() => vi.advanceTimersByTimeAsync(4100));
      expect(shown()).toBe(false);
      dock.covered = false;
      await act(() => vi.advanceTimersByTimeAsync(DOCK_ASK_MS + 10));
      await waitFor(() => expect(shown()).toBe(true));
    });

    it("keeps out of the way while the computer can't say, and asks nothing of a covered stage", async () => {
      const { api, fetchImpl } = daemon({ covered: null });
      const view = desktopFront(api);
      await waitFor(() => expect(asked(fetchImpl)).toBe(1));
      await act(() => Promise.resolve());
      expect(shown()).toBe(false);
      expect(edge()).not.toBeNull();
      view.rerender(
        <Stage
          {...props(api)}
          cell={cell(DESKTOP)}
          selection={onDesktop}
          front={frontOf({})}
          covered
        />,
      );
      fakeTimers();
      await act(() => vi.advanceTimersByTimeAsync(DOCK_ASK_MS * 3));
      expect(asked(fetchImpl)).toBe(1);
    });
  });

  it("marks the dock item while dot works in the minimised window", async () => {
    const { api } = daemon();
    render(
      <Stage
        {...props(api)}
        cell={cell(DESKTOP)}
        selection={onDesktop}
        front={frontOf({ dot: "browser" })}
      />,
    );
    const item = await screen.findByRole("button", {
      name: "Show the web browser, where dot is working",
    });
    expect(item.hasAttribute("data-dot")).toBe(true);
    expect(item.hasAttribute("data-open")).toBe(false);
  });

  it("gives the window in front the desktop's title bar, with its name and a minimise light", async () => {
    const { api } = daemon();
    const front = frontOf({ screen: "browser", dot: "browser", browser: onBrowser });
    await bothOn(api, { front, browserEngine: "chromium" });
    // The frame comes with the page in it, not before.
    expect(screen.queryByRole("group", { name: /window$/ })).toBeNull();
    mainStats();
    const bar = await screen.findByRole("group", { name: "Chromium window" });
    expect(bar.textContent).toBe("Chromium");
    const lights = within(bar).getAllByRole("button");
    expect(lights.map((light) => light.getAttribute("aria-label"))).toEqual([
      "Minimise the web browser",
    ]);
    fireEvent.click(lights[0] as HTMLElement);
    expect(front.pick).toHaveBeenCalledWith("desktop");
    // The dock gets out of the window's way until the pointer reaches the bottom edge.
    const dock = document.querySelector(".browser-dock") as HTMLElement;
    expect(dock.hasAttribute("data-shown")).toBe(false);
    fireEvent.pointerEnter(document.querySelector(".browser-dock-edge") as HTMLElement, {
      pointerType: "mouse",
    });
    expect(dock.hasAttribute("data-shown")).toBe(true);
    const item = within(dock).getByRole("button", { name: "Minimise the web browser" });
    expect(item.hasAttribute("data-open")).toBe(true);
  });

  it("draws the window's title bar where nothing picks the screen in front, and no dock", async () => {
    const { api } = daemon();
    await bothOn(api);
    mainStats();
    const bar = await screen.findByRole("group", { name: "Web browser window" });
    expect(within(bar).queryByRole("button")).toBeNull();
    expect(document.querySelector(".browser-dock")).toBeNull();
  });

  it("draws one screen in Replay, and no desktop under it", () => {
    const { api, fetchImpl } = daemon();
    render(<Stage {...props(api)} mode="replay" cell={null} />);
    expect(
      sent("view").findLast(
        (message) => (message.view as { composite?: unknown }).composite !== undefined,
      )?.view,
    ).toEqual({ composite: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the desktop under the window as a picture, refreshed now and then", async () => {
    fakeTimers();
    const { api } = daemon();
    const { send } = await bothOn(api);
    const stops = () => send.mock.calls.filter(([text]) => text === "STOP_VIDEO").length;
    expect(stops()).toBe(0);
    underStats();
    // A fresh picture has time to come, then nothing is decoded.
    await act(() => vi.advanceTimersByTimeAsync(UNDER_AWAKE_MS + 10));
    expect(stops()).toBe(1);
    expect(frames("desktop")).toHaveLength(1);
    send.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(UNDER_REFRESH_MS));
    expect(send).toHaveBeenCalledWith("START_VIDEO");
    expect(send).toHaveBeenCalledWith("REQUEST_KEYFRAME");
  });

  it("keeps the desktop live while the user's hands may reach it", async () => {
    fakeTimers();
    const { api } = daemon();
    const manual = {
      enabled: true,
      screen: { w: 2560, h: 1600 },
      pointer: "click" as const,
      send: vi.fn(),
    };
    const { send } = await bothOn(api, { manual });
    underStats();
    await act(() => vi.advanceTimersByTimeAsync(UNDER_AWAKE_MS + 10));
    expect(send).not.toHaveBeenCalledWith("STOP_VIDEO");
  });

  it("uses the stream it already has when the desktop comes forward", async () => {
    const { api, fetchImpl } = daemon();
    const { view } = await bothOn(api);
    const minted = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/stream-ticket"),
    ).length;
    view.rerender(<Stage {...props(api)} cell={cell(DESKTOP)} selection={onDesktop} />);
    await waitFor(() =>
      expect(
        sent("view").findLast(
          (message) => (message.view as { composite?: unknown }).composite !== undefined,
        )?.view,
      ).toEqual({ composite: { front: "desktop", desktop: { w: 2560, h: 1600 } } }),
    );
    await waitFor(() => expect(sent("stop").some((message) => message.under)).toBe(true));
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).includes("/stream-ticket")),
    ).toHaveLength(minted);
    expect(frames("desktop")).toHaveLength(1);
  });

  describe("under the user's hands", () => {
    const rect = {
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      right: 1280,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    async function held(front?: Partial<StageFront>) {
      vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(readonly report: ResizeObserverCallback) {}
          observe() {
            this.report(
              [{ contentRect: { width: 1280, height: 800 } }] as ResizeObserverEntry[],
              this as unknown as ResizeObserver,
            );
          }
          disconnect() {}
        },
      );
      const { api } = daemon();
      const sendInput = vi.fn<(input: ManualStreamInput) => void>();
      const pick = vi.fn();
      const stageFront: StageFront = {
        screen: "browser",
        dot: "browser",
        browser: onBrowser,
        problem: null,
        pick,
        route: (input) => input,
        ...front,
      };
      await bothOn(api, {
        front: stageFront,
        manual: { enabled: true, screen: { w: 2560, h: 1600 }, pointer: "click", send: sendInput },
      });
      mainStats();
      const surface = document.querySelector(".manual-surface") as HTMLElement;
      await waitFor(() => expect(surface.hasAttribute("data-live")).toBe(true));
      return { surface, sendInput, pick };
    }
    const press = (surface: HTMLElement, clientX: number, clientY: number) => {
      const at = { pointerId: 1, pointerType: "mouse", button: 0, clientX, clientY };
      fireEvent.pointerDown(surface, at);
      fireEvent.pointerUp(surface, at);
    };

    it("sends a press on the window to the browser's own pixels", async () => {
      const { surface, sendInput, pick } = await held();
      press(surface, 640, 412);
      const down = sendInput.mock.calls.map(([input]) => input).find((i) => i.kind === "down");
      expect(down).toMatchObject({
        screen: "browser",
        at: { x: 1280, y: Math.floor((824 - 104) / 0.935) },
      });
      expect(Object.keys((down as { at: object }).at)).toEqual(["x", "y"]);
      expect(pick).not.toHaveBeenCalled();
    });

    it("sends a press on the bar to the desktop, and brings it forward once it lets go", async () => {
      const { surface, sendInput, pick } = await held();
      const at = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 640, clientY: 10 };
      fireEvent.pointerDown(surface, at);
      expect(sendInput.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: "down",
        screen: "desktop",
        at: { x: 1280, y: 20 },
      });
      expect(pick).not.toHaveBeenCalled();
      fireEvent.pointerUp(surface, at);
      expect(sendInput.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "up", screen: "desktop" });
      expect(pick).toHaveBeenCalledWith("desktop");
    });

    it("brings the desktop forward from a press beside the window, and sends it nothing", async () => {
      const { surface, sendInput, pick } = await held();
      press(surface, 4, 400);
      expect(sendInput).not.toHaveBeenCalled();
      expect(pick).toHaveBeenCalledWith("desktop");
    });

    it("scrolls the screen under the pointer", async () => {
      const { surface, sendInput } = await held();
      fireEvent.wheel(surface, { clientX: 640, clientY: 412, deltaY: 120, deltaMode: 0 });
      fireEvent.wheel(surface, { clientX: 640, clientY: 10, deltaY: 120, deltaMode: 0 });
      await waitFor(() =>
        expect(
          sendInput.mock.calls.map(([input]) => [input.kind, "screen" in input && input.screen]),
        ).toEqual([
          ["scroll", "browser"],
          ["scroll", "desktop"],
        ]),
      );
    });

    it("says where keys go: to the window in front, and how to bring the other forward", async () => {
      await held();
      expect(screen.getByLabelText("Type on the computer").getAttribute("aria-description")).toBe(
        "Keys go to the web browser's window. Alt+Tab brings the desktop forward.",
      );
    });

    it("switches windows on Alt+Tab, which reaches neither screen", async () => {
      const { sendInput, pick } = await held();
      const field = screen.getByLabelText("Type on the computer");
      fireEvent.keyDown(field, { key: "Tab", altKey: true });
      expect(pick).toHaveBeenCalledWith("desktop");
      fireEvent.keyDown(field, { key: "Tab", metaKey: true });
      expect(pick).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(field, { key: "Tab", ctrlKey: true });
      expect(pick).toHaveBeenCalledTimes(2);
      expect(sendInput.mock.calls.map(([input]) => input)).toEqual([
        { kind: "key", combo: ["ctrl", "tab"] },
      ]);
      // From the page with nothing focused too, but not from a field of the app's own.
      fireEvent.keyDown(document.body, { key: "Tab", altKey: true });
      expect(pick).toHaveBeenCalledTimes(3);
      const other = document.createElement("textarea");
      document.body.append(other);
      fireEvent.keyDown(other, { key: "Tab", altKey: true });
      expect(pick).toHaveBeenCalledTimes(3);
      other.remove();
    });

    it("keeps a drag on its own screen, at that screen's edge", async () => {
      const { surface, sendInput } = await held();
      const at = { pointerId: 1, pointerType: "mouse", button: 0 };
      fireEvent.pointerDown(surface, { ...at, clientX: 640, clientY: 400 });
      fireEvent.pointerMove(surface, { ...at, clientX: 640, clientY: 2 });
      fireEvent.pointerUp(surface, { ...at, clientX: 640, clientY: 2 });
      const moved = sendInput.mock.calls.map(([input]) => input).filter((i) => i.kind === "up")[0];
      expect(moved).toMatchObject({ screen: "browser", at: { y: 0 } });
    });
  });
});
