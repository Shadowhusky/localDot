// @vitest-environment jsdom
import { emptyManifest } from "@localdot/protocol";
import { buildPlaybackMap, emptyModel } from "@localdot/stage";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyAgentModel } from "../agent/model.ts";
import { createApi } from "../lib/api.ts";
import { WorkHistory } from "../work/work-view.ts";
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
    screenChoice: "auto",
    status: "ready",
    card: null,
    info: { manifest: emptyManifest("none"), live: false, upto: 0, servedBytes: 0 },
    model: emptyModel(),
    agent: emptyAgentModel(),
    work: new WorkHistory(),
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
    retry: vi.fn(),
  };
}

const api = createApi("a".repeat(43), { origin: "http://127.0.0.1" });

it("plays, skips ten seconds, changes speed and skips idle through the kit's controls", async () => {
  const state = replay();
  render(<ReplayControls api={api} replay={state} />);
  const group = screen.getByRole("group", { name: "Playback controls" });
  expect(group.querySelector("select, input[type=checkbox]:not([role=switch])")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
  expect(state.run).toHaveBeenCalledWith({ kind: "toggle-play" });
  fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
  expect(state.run).toHaveBeenCalledWith({ kind: "jump", ms: 10_000 });
  const skip = screen.getByRole("button", { name: "Skip idle" });
  expect(skip.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(skip);
  expect(state.setSkipIdle).toHaveBeenCalledWith(false);
  const speed = screen.getByRole("combobox", { name: "Playback speed" });
  expect(speed.textContent).toContain("1×");
  fireEvent.click(speed);
  fireEvent.click(await screen.findByRole("option", { name: "4×" }));
  expect(state.setSpeed).toHaveBeenCalledWith(4);
});

it("keeps only play and the scrubber on a phone", () => {
  render(<ReplayControls api={api} replay={replay()} compact />);
  expect(screen.getByRole("button", { name: "Play replay" })).toBeTruthy();
  expect(screen.getByRole("slider", { name: "Replay timeline" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Forward 10 seconds" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Playback speed" })).toBeNull();
});

it("names a recording with no video once its card has gone", () => {
  const { rerender } = render(<ReplayControls api={api} replay={replay()} />);
  expect(screen.queryByText("No video")).toBeNull();
  rerender(<ReplayControls api={api} replay={replay()} noVideo />);
  expect(screen.getByText("No video")).toBeTruthy();
});

it("keeps the no-video chip's room while the card says so, so the bar never moves", () => {
  const { rerender } = render(<ReplayControls api={api} replay={replay()} noVideo cardShown />);
  const chip = screen.getByText("No video").closest(".replay-no-video");
  expect(chip?.hasAttribute("data-held")).toBe(true);
  rerender(<ReplayControls api={api} replay={replay()} noVideo />);
  expect(screen.getByText("No video").closest(".replay-no-video")).toBe(chip);
  expect(chip?.hasAttribute("data-held")).toBe(false);
});

it("names a recording with no video on a phone too", () => {
  render(<ReplayControls api={api} replay={replay()} compact noVideo />);
  expect(screen.getByRole("group", { name: "Playback controls" }).textContent).toContain(
    "No video",
  );
});
