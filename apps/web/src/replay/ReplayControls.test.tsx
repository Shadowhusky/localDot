// @vitest-environment jsdom
import { emptyManifest } from "@localdot/protocol";
import { buildPlaybackMap, emptyModel } from "@localdot/stage";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReplayControls } from "./ReplayControls.tsx";
import type { ReplayState } from "./useReplay.ts";

const REASON = "Export needs Chrome or Edge for now";

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
    setScreen: vi.fn(),
    run: vi.fn(),
    seek: vi.fn(),
    setSpeed: vi.fn(),
    setSkipIdle: vi.fn(),
    selectStep: vi.fn(),
  };
}

it("keeps Export focusable but off, and says why, where the browser cannot save a file", () => {
  vi.stubGlobal("showSaveFilePicker", undefined);
  const onExport = vi.fn();
  render(<ReplayControls replay={replay()} onExport={onExport} />);
  const trigger = screen.getByRole("button", { name: "Export MP4" });
  expect(trigger.getAttribute("aria-disabled")).toBe("true");
  expect(trigger.hasAttribute("disabled")).toBe(false);
  const reason = screen.getByText(REASON);
  expect(trigger.getAttribute("aria-describedby")).toBe(reason.id);
  fireEvent.click(trigger);
  expect(onExport).not.toHaveBeenCalled();
});

it("opens Export where the browser can save a file", () => {
  vi.stubGlobal("showSaveFilePicker", vi.fn());
  vi.stubGlobal("VideoEncoder", class {});
  vi.stubGlobal("OffscreenCanvas", class {});
  const onExport = vi.fn();
  render(<ReplayControls replay={replay()} onExport={onExport} />);
  const trigger = screen.getByRole("button", { name: "Export MP4" });
  expect(trigger.hasAttribute("aria-disabled")).toBe(false);
  expect(trigger.hasAttribute("aria-describedby")).toBe(false);
  expect(screen.queryByText(REASON)).toBeNull();
  fireEvent.click(trigger);
  expect(onExport).toHaveBeenCalledWith(trigger);
});
