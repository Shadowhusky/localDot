// @vitest-environment jsdom

import type { ManualStreamInput, Point } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStopHotkey } from "../agent/useStopHotkey.ts";
import { ManualSurface } from "./ManualSurface.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Control({
  live,
  send,
  stop,
}: {
  live: boolean;
  send(input: ManualStreamInput): void;
  stop(): void;
}) {
  useStopHotkey(stop, true);
  return <ManualSurface live={live} mode="click" locate={(point: Point) => point} send={send} />;
}

it("keeps the Stop shortcut in the browser while the computer has the keyboard", () => {
  const send = vi.fn<(input: ManualStreamInput) => void>(),
    stop = vi.fn();
  render(<Control live send={send} stop={stop} />);
  const keys = screen.getByLabelText<HTMLTextAreaElement>("Type on the computer");
  keys.focus();
  expect(document.activeElement).toBe(keys);
  for (const mod of [{ ctrlKey: true }, { metaKey: true }])
    fireEvent.keyDown(keys, { key: ".", code: "Period", shiftKey: true, ...mod });
  expect(stop).toHaveBeenCalledTimes(2);
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(keys, { key: "a", ctrlKey: true });
  expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "key", combo: ["ctrl", "a"] });
});

it("drops a hover move still waiting for its frame once the computer stops taking input", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const send = vi.fn<(input: ManualStreamInput) => void>();
  const view = render(<Control live send={send} stop={() => {}} />);
  const surface = document.querySelector(".manual-surface") as HTMLElement;
  fireEvent.pointerMove(surface, { pointerId: 1, pointerType: "mouse", clientX: 5, clientY: 6 });
  expect(frames).toHaveLength(1);
  view.rerender(<Control live={false} send={send} stop={() => {}} />);
  for (const frame of frames.splice(0)) frame(0);
  expect(send).not.toHaveBeenCalled();
});
