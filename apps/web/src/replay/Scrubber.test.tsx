// @vitest-environment jsdom
import { emptyManifest } from "@localdot/protocol";
import { buildPlaybackMap, emptyModel, type ReplaySpeed } from "@localdot/stage";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyAgentModel } from "../agent/model.ts";
import { createApi } from "../lib/api.ts";
import { WorkHistory } from "../work/work-view.ts";
import { Scrubber } from "./Scrubber.tsx";
import type { ReplayState } from "./useReplay.ts";

const api = createApi("a".repeat(43), { fetchImpl: (async () => new Response()) as typeof fetch });
const map = buildPlaybackMap(0, 60_000, [{ from: 0, to: 60_000 }], true);
let now = 1000;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  now = 1000;
  frames = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 600,
    height: 40,
    right: 600,
    bottom: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  Object.assign(HTMLElement.prototype, {
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => true,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function state(patch: {
  tMs: number;
  playing: boolean;
  speed?: ReplaySpeed;
  selection?: ReplayState["selection"];
}): ReplayState {
  return {
    sessionId: "01M4D263DDHCRM52FMG340DDF3",
    screen: "desktop",
    screenChoice: "auto",
    status: "ready",
    card: null,
    info: { manifest: emptyManifest("none"), live: false, upto: 0, servedBytes: 0 },
    model: emptyModel(),
    agent: emptyAgentModel(),
    work: new WorkHistory(),
    version: 0,
    speed: 1,
    skipIdle: true,
    idleNow: false,
    map,
    compare: null,
    selection: null,
    setScreen: vi.fn(),
    run: vi.fn(),
    seek: vi.fn(),
    setSpeed: vi.fn(),
    setSkipIdle: vi.fn(),
    selectStep: vi.fn(),
    retry: vi.fn(),
    ...patch,
  };
}

const head = () => document.querySelector<HTMLElement>(".replay-playhead")?.style.transform;
function frame(at: number) {
  now = at;
  const pending = frames;
  frames = [];
  for (const callback of pending) callback(at);
}

it("runs the playhead on its own clock between reports, and never steps it back", () => {
  const replay = state({ tMs: 10_000, playing: true });
  const { rerender } = render(<Scrubber api={api} sessionId="s" replay={replay} />);
  expect(head()).toBe("translateX(100px)");
  frame(1600);
  expect(head()).toBe("translateX(106px)");
  frame(2200);
  expect(head()).toBe("translateX(112px)");
  // A report a little behind the clock leaves it running from where it is.
  rerender(<Scrubber api={api} sessionId="s" replay={{ ...replay, tMs: 11_000 }} />);
  expect(head()).toBe("translateX(112px)");
  // Paused, the head rests exactly where the worker says.
  rerender(
    <Scrubber api={api} sessionId="s" replay={{ ...replay, tMs: 11_000, playing: false }} />,
  );
  expect(head()).toBe("translateX(110px)");
});

it("moves with a doubled speed at once, without waiting for the next report", () => {
  const replay = state({ tMs: 30_000, playing: true });
  const { rerender } = render(<Scrubber api={api} sessionId="s" replay={replay} />);
  rerender(<Scrubber api={api} sessionId="s" replay={{ ...replay, speed: 2 }} />);
  frame(1500);
  expect(head()).toBe("translateX(310px)");
});

it("brackets the stretch marked with I and O, and says so", () => {
  const replay = state({ tMs: 0, playing: false, selection: { fromMs: 15_000, toMs: 45_000 } });
  const { rerender } = render(<Scrubber api={api} sessionId="s" replay={replay} />);
  const band = screen.getByTestId("replay-selection");
  expect(band.style.left).toBe("25%");
  expect(band.style.width).toBe("50%");
  const slider = screen.getByRole("slider", { name: "Replay timeline" });
  expect(slider.getAttribute("aria-description")).toBe("Marked 0:15 to 0:45");
  rerender(<Scrubber api={api} sessionId="s" replay={{ ...replay, selection: null }} />);
  expect(screen.queryByTestId("replay-selection")).toBeNull();
  expect(slider.hasAttribute("aria-description")).toBe(false);
});

it("tracks a drag one to one and keeps playing after it if it was playing", () => {
  const replay = state({ tMs: 0, playing: true });
  render(<Scrubber api={api} sessionId="s" replay={replay} />);
  const slider = screen.getByRole("slider", { name: "Replay timeline" });
  fireEvent.pointerDown(slider, { button: 0, clientX: 300, pointerId: 1 });
  expect(head()).toBe("translateX(300px)");
  expect(replay.seek).toHaveBeenLastCalledWith(30_000, "preview");
  fireEvent.pointerMove(slider, { clientX: 450, pointerId: 1 });
  expect(head()).toBe("translateX(450px)");
  expect(replay.run).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider, { clientX: 450, pointerId: 1 });
  expect(replay.seek).toHaveBeenLastCalledWith(45_000, "exact");
  expect(replay.run).toHaveBeenCalledWith({ kind: "toggle-play" });
});
