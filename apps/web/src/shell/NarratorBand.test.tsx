// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NarratorBand } from "./NarratorBand.tsx";
import { LINE_HOLD_MS } from "./narration.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const line = () => document.querySelector(".narration-line");

it("holds each line long enough to read, then fades it out before the next comes in", () => {
  vi.useFakeTimers();
  const band = render(<NarratorBand line="Opening the report" speaker="dot" showDot />);
  band.rerender(<NarratorBand line="Selecting February's net total" speaker="dot" showDot />);
  act(() => vi.advanceTimersByTime(LINE_HOLD_MS - 10));
  expect(line()?.textContent).toBe("dot: Opening the report");
  expect(line()?.hasAttribute("data-leaving")).toBe(false);
  act(() => vi.advanceTimersByTime(10));
  expect(line()?.hasAttribute("data-leaving")).toBe(true);
  act(() => vi.advanceTimersByTime(120));
  expect(line()?.textContent).toBe("dot: Selecting February's net total");
  expect(line()?.hasAttribute("data-leaving")).toBe(false);
});

it("never flips back and forth: a line that returns within its hold keeps the band still", () => {
  vi.useFakeTimers();
  const band = render(<NarratorBand line="Opening Telegram" speaker="dot" showDot />);
  band.rerender(<NarratorBand line="Clicked “Search”" speaker="dot" showDot />);
  act(() => vi.advanceTimersByTime(LINE_HOLD_MS / 2));
  band.rerender(<NarratorBand line="Opening Telegram" speaker="dot" showDot />);
  act(() => vi.advanceTimersByTime(LINE_HOLD_MS * 2));
  expect(line()?.textContent).toBe("dot: Opening Telegram");
  expect(line()?.hasAttribute("data-leaving")).toBe(false);
});

it("brings the first line after a silence in at once", () => {
  vi.useFakeTimers();
  const band = render(<NarratorBand line="" speaker="dot" showDot />);
  band.rerender(<NarratorBand line="Opening Telegram" speaker="dot" showDot />);
  act(() => vi.advanceTimersByTime(1));
  expect(line()?.textContent).toBe("dot: Opening Telegram");
});

it("brings a line for the user in at once, without waiting out the last line's hold", () => {
  vi.useFakeTimers();
  const band = render(<NarratorBand line="Opening the report" speaker="dot" showDot />);
  band.rerender(<NarratorBand line="Which report?" speaker="dot" showDot forUser />);
  act(() => vi.advanceTimersByTime(120));
  expect(line()?.textContent).toBe("dot: Which report?");
  band.rerender(<NarratorBand line="Sign in to your bank" speaker="dot" showDot reveal />);
  act(() => vi.advanceTimersByTime(120));
  expect(line()?.textContent).toBe("dot: Sign in to your bank");
});

it("names its speaker on screen only when dot isn't beside it", () => {
  render(<NarratorBand line="Checking the totals" speaker="dot" showDot={false} />);
  expect(document.querySelector(".narration-speaker")?.textContent).toBe("dot");
  expect(document.querySelector(".narrator-dock")).toBeNull();
  cleanup();
  render(<NarratorBand line="Checking the totals" speaker="dot" showDot />);
  expect(document.querySelector(".narration-speaker")).toBeNull();
  expect(document.querySelector(".narrator-dock")).not.toBeNull();
});

it("shows the hidden characters in dot's question, with a warning, and only while it is the question", () => {
  vi.useFakeTimers();
  const asked = "Sign in to ‮kcab‬ your bank";
  const band = render(<NarratorBand line={asked} speaker="dot" showDot reveal />);
  expect(line()?.textContent).toBe("dot: Sign in to·U+202EkcabU+202C·your bank");
  expect(line()?.textContent).not.toContain("‮");
  expect(document.querySelector(".narration-warning")?.textContent).toBe(
    "Contains hidden characters that change text direction, shown as U+ codes.",
  );
  band.rerender(<NarratorBand line="Signing in" speaker="dot" showDot />);
  expect(line()?.textContent).toBe("dot: Sign in to·U+202EkcabU+202C·your bank");
  act(() => vi.advanceTimersByTime(LINE_HOLD_MS + 120));
  expect(line()?.textContent).toBe("dot: Signing in");
  expect(document.querySelector(".narration-warning")).toBeNull();
});

it("lets a line too long for its two lines be read whole, by hover or by a tap", () => {
  const long =
    "Please sign in to Telegram Web. It is open on the computer and showing a code to scan, or you can log in by phone number instead";
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("narration-line") ? 66 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("narration-line") ? 44 : 0;
  });
  render(<NarratorBand line={long} speaker="dot" showDot />);
  const opener = screen.getByRole("button", { name: "Show the whole line" });
  expect(opener.title).toBe(long);
  act(() => opener.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toBe(long);
});

it("announces a clamped line as plain text, its opener outside the live region", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("narration-line") ? 66 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("narration-line") ? 44 : 0;
  });
  render(<NarratorBand line="A line too long for its two lines" speaker="dot" showDot />);
  const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
  expect(live.querySelector('[role="button"], [tabindex]')).toBeNull();
  const opener = screen.getByRole("button", { name: "Show the whole line" });
  expect(live.contains(opener)).toBe(false);
  act(() => {
    fireEvent.keyDown(opener, { key: "Enter" });
  });
  expect(document.querySelector('[role="dialog"]')?.textContent).toBe(
    "A line too long for its two lines",
  );
});

it("leaves a line that fits as plain text", () => {
  render(<NarratorBand line="Opening the report" speaker="dot" showDot />);
  expect(line()?.hasAttribute("title")).toBe(false);
  expect(line()?.hasAttribute("role")).toBe(false);
  expect(screen.queryByRole("button", { name: "Show the whole line" })).toBeNull();
});

it("gives a tip its one step, outside the live region, and the step leaves with its line", () => {
  vi.useFakeTimers();
  const run = vi.fn();
  const band = render(
    <NarratorBand
      line="Replay keeps every task."
      speaker="dot"
      showDot
      idle
      forUser
      action={{ label: "Open", run }}
    />,
  );
  const step = screen.getByRole("button", { name: "Open" });
  const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
  expect(live.contains(step)).toBe(false);
  expect(live.textContent).toBe("dot: Replay keeps every task.");
  expect(document.querySelector(".narration")?.hasAttribute("data-idle")).toBe(true);
  act(() => step.click());
  expect(run).toHaveBeenCalledWith(step);
  band.rerender(<NarratorBand line="Press / to type." speaker="dot" showDot idle forUser />);
  expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  act(() => vi.advanceTimersByTime(120));
  expect(line()?.textContent).toBe("dot: Press / to type.");
  expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  band.rerender(<NarratorBand line="Opening the report" speaker="dot" showDot />);
  act(() => vi.advanceTimersByTime(LINE_HOLD_MS + 120));
  expect(document.querySelector(".narration")?.hasAttribute("data-idle")).toBe(false);
});

it("says when the pointer is over the band", () => {
  const onHover = vi.fn();
  render(<NarratorBand line="Morning." speaker="dot" showDot idle onHover={onHover} />);
  const narrator = document.querySelector(".narrator") as HTMLElement;
  fireEvent.pointerEnter(narrator);
  expect(onHover).toHaveBeenLastCalledWith(true);
  fireEvent.pointerLeave(narrator);
  expect(onHover).toHaveBeenLastCalledWith(false);
});
