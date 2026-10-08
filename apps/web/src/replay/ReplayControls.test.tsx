// @vitest-environment jsdom
import { emptyManifest } from "@localdot/protocol";
import { buildPlaybackMap, emptyModel } from "@localdot/stage";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReplayControls } from "./ReplayControls.tsx";
import type { ReplayState } from "./useReplay.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function replay(): ReplayState {
  return {
    sessionId: "01M4D263DDHCRM52FMG340DDF3",
    screen: "desktop",
    status: "ready",
    card: null,
    info: { manifest: emptyManifest("none"), live: false, upto: 0, servedBytes: 0 },
    model: emptyModel(),
    version: 0,
    tMs: 0,
    playing: false,
    speed: 1,
    skipIdle: true,
    idleNow: false,
    map: buildPlaybackMap(0, 60_000, [], true),
    compare: null,
    selection: null,
    setScreen: vi.fn(),
    run: vi.fn(),
    seek: vi.fn(),
    setSpeed: vi.fn(),
    setSkipIdle: vi.fn(),
    selectStep: vi.fn(),
  };
}

it("plays, steps, changes speed and skips idle through the kit's controls", async () => {
  const state = replay();
  render(<ReplayControls replay={state} label="Typing a sample" />);
  const group = screen.getByRole("group", { name: "Playback controls" });
  expect(group.querySelector("select, input[type=checkbox]:not([role=switch])")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
  expect(state.run).toHaveBeenCalledWith({ kind: "toggle-play" });
  fireEvent.click(screen.getByRole("button", { name: "Next step" }));
  expect(state.run).toHaveBeenCalledWith({ kind: "step", dir: 1 });
  fireEvent.click(screen.getByRole("switch", { name: "Skip idle" }));
  expect(state.setSkipIdle).toHaveBeenCalledWith(false);
  const speed = screen.getByRole("combobox", { name: "Playback speed" });
  expect(speed.textContent).toContain("1×");
  fireEvent.click(speed);
  fireEvent.click(await screen.findByRole("option", { name: "4×" }));
  expect(state.setSpeed).toHaveBeenCalledWith(4);
  expect(screen.getByText("Typing a sample")).toBeTruthy();
});

it("names a recording with no video once its card has gone", () => {
  const { rerender } = render(<ReplayControls replay={replay()} label="Working" />);
  expect(screen.queryByText("No video")).toBeNull();
  rerender(<ReplayControls replay={replay()} label="Working" noVideo />);
  expect(screen.getByText("No video")).toBeTruthy();
});
