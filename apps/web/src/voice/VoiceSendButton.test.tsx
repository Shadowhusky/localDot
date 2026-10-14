// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Voice } from "./useVoice.ts";
import { VOICE_HOLD_MS, VoiceSendButton } from "./VoiceSendButton.tsx";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function setup(enabled = true) {
  const send = vi.fn();
  const action = vi.fn();
  const voice = { enabled, state: { phase: "idle" }, send, dismiss: vi.fn() } as unknown as Voice;
  const view = render(
    <VoiceSendButton voice={voice} icon="arrow-up" label="Send" onClick={action} />,
  );
  const button = screen.getByRole("button", { name: "Send" });
  return { ...view, voice, send, action, button };
}
it("keeps a quick tap as Send", () => {
  const f = setup();
  fireEvent.pointerDown(f.button, { button: 0, pointerId: 1 });
  act(() => vi.advanceTimersByTime(100));
  fireEvent.pointerUp(f.button, { pointerId: 1 });
  fireEvent.click(f.button);
  act(() => vi.advanceTimersByTime(VOICE_HOLD_MS));
  expect(f.action).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
});
it("latches voice after a deliberate hold and consumes its release click", () => {
  const f = setup();
  fireEvent.pointerDown(f.button, { button: 0, pointerId: 1 });
  act(() => vi.advanceTimersByTime(VOICE_HOLD_MS));
  expect(f.send.mock.calls.map(([event]) => event.type)).toEqual(["press", "release"]);
  fireEvent.pointerUp(f.button, { pointerId: 1 });
  fireEvent.click(f.button);
  expect(f.action).not.toHaveBeenCalled();
});
it.each(["move", "cancel", "unmount"])("cancels a pending hold on %s", (kind) => {
  const f = setup();
  fireEvent.pointerDown(f.button, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  if (kind === "move") fireEvent.pointerMove(f.button, { pointerId: 1, clientX: 30, clientY: 10 });
  if (kind === "cancel") fireEvent.pointerCancel(f.button);
  if (kind === "unmount") f.unmount();
  act(() => vi.advanceTimersByTime(VOICE_HOLD_MS));
  expect(f.send).not.toHaveBeenCalled();
  if (kind !== "unmount") fireEvent.click(f.button);
  expect(f.action).not.toHaveBeenCalled();
});
it("never starts voice when the composer cannot accept input", () => {
  const f = setup(false);
  fireEvent.pointerDown(f.button, { button: 0, pointerId: 1 });
  act(() => vi.advanceTimersByTime(VOICE_HOLD_MS));
  expect(f.send).not.toHaveBeenCalled();
});
it("finishes keyboard or pointer dictation without sending", () => {
  const f = setup();
  f.rerender(
    <VoiceSendButton
      voice={{
        ...f.voice,
        state: { phase: "listening", held: true, away: false, at: 0, since: 0 },
      }}
      icon="arrow-up"
      label="Send"
      onClick={f.action}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Finish speaking" }));
  expect(f.send).toHaveBeenCalledWith({ type: "stop" });
  expect(f.action).not.toHaveBeenCalled();
});
it("shows the pointing hint only on first use", () => {
  const f = setup();
  act(() => vi.advanceTimersByTime(1200));
  expect(screen.getByRole("tooltip").textContent).toBe("Hold to speak");
  f.unmount();
  setup();
  act(() => vi.advanceTimersByTime(1200));
  expect(screen.queryByText("Hold to speak")).toBeNull();
});
