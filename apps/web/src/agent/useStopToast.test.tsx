// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupNote, stopNotice, stoppedOff } from "./useStopToast.ts";
import type { StopStatus } from "./useTaskControls.ts";

type Kit = typeof import("../ui/Toast.tsx") & typeof import("./useStopToast.ts");
let kit: Kit;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.resetModules();
  kit = { ...(await import("../ui/Toast.tsx")), ...(await import("./useStopToast.ts")) };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PAUSE = "pause: could not confirm completion";
const KEYS = "keyd: could not confirm completion";
const at = (phase: StopStatus["phase"], errors: string[] = []): StopStatus => ({ phase, errors });

function Island({ status, recheck }: { status: StopStatus; recheck(): void }) {
  const island = useRef<HTMLDivElement>(null);
  kit.useStopToast(status, recheck);
  return (
    <div>
      <div ref={island}>Island</div>
      <kit.Toaster anchor={island} />
    </div>
  );
}
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
const toasts = () => screen.queryAllByRole("listitem").map((item) => item.textContent);

it("says nothing while Stop is on its way: the island's label does", () => {
  expect(stopNotice(at("idle"))).toBeNull();
  expect(stopNotice(at("sending"))).toBeNull();
});

it("tells a paused computer from one that is off, the reason in the title", () => {
  expect(stopNotice(at("paused"))).toMatchObject({
    title: "Stopped. Your computer is paused.",
    icon: "stop",
  });
  expect(stopNotice(at("paused"))?.details).toBeUndefined();
  const off = stopNotice(at("stopped", [PAUSE, KEYS]));
  expect(off?.title).toBe("Stopped. Your computer couldn't pause, so it's off.");
  expect(off?.details).toEqual([cleanupNote(KEYS)]);
  expect(stopNotice(at("stopped"))?.title).toBe("Stopped. Your computer is off.");
});

it("leaves a computer that is off to the curtain, unless a note still needs saying", () => {
  expect(stopNotice(at("stopped", [PAUSE]), true)).toBeNull();
  expect(stopNotice(at("stopped", [PAUSE, KEYS]), true)?.details).toEqual([cleanupNote(KEYS)]);
  expect(stoppedOff(at("stopped", [PAUSE]))).toBe(
    "dot stopped. Your computer couldn't pause, so it's off. Your files are kept.",
  );
  expect(stoppedOff(at("paused"))).toBeNull();
});

it("puts cleanup notes in plain words, never the daemon's", () => {
  for (const error of [PAUSE, KEYS, "keyd close: could not confirm completion", "other"]) {
    const note = cleanupNote(error);
    expect(note).not.toMatch(/keyd|could not confirm completion/);
    expect(note.endsWith(".")).toBe(true);
  }
});

it("drops the outcome from the island once settled, and lets it go on its own", () => {
  const recheck = vi.fn();
  const view = render(<Island status={at("sending")} recheck={recheck} />);
  wait(1000);
  expect(toasts()).toEqual([]);
  view.rerender(<Island status={at("paused")} recheck={recheck} />);
  wait(500);
  expect(toasts()).toEqual(["Stopped. Your computer is paused."]);
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  wait(6000);
  expect(toasts().filter(Boolean)).toHaveLength(0);
});

it("keeps an unconfirmed Stop up with Check again, and its notes behind Details", () => {
  const recheck = vi.fn();
  render(<Island status={at("unconfirmed", [PAUSE])} recheck={recheck} />);
  wait(60_000);
  expect(screen.getByText("Couldn't confirm that dot stopped.")).toBeTruthy();
  const details = screen.getByRole("button", { name: "Details" });
  expect(details.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(details);
  expect(screen.getByText(cleanupNote(PAUSE))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(recheck).toHaveBeenCalledOnce();
});

it("withdraws the outcome once the computer is back", () => {
  const recheck = vi.fn();
  const view = render(<Island status={at("unconfirmed")} recheck={recheck} />);
  wait(1000);
  expect(toasts()).toHaveLength(1);
  view.rerender(<Island status={at("idle")} recheck={recheck} />);
  wait(2000);
  expect(toasts().filter(Boolean)).toHaveLength(0);
});
