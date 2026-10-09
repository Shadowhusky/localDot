// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LINE_HOLD_MS, NarratorBand } from "./NarratorBand.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const line = () => document.querySelector(".narration-line");

it("holds each line for a second, then fades it out before the next comes in", () => {
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

it("names its speaker on screen only when dot isn't beside it", () => {
  render(<NarratorBand line="Checking the totals" speaker="dot" showDot={false} />);
  expect(document.querySelector(".narration-speaker")?.textContent).toBe("dot");
  expect(document.querySelector(".narrator-dock")).toBeNull();
  cleanup();
  render(<NarratorBand line="Checking the totals" speaker="dot" showDot />);
  expect(document.querySelector(".narration-speaker")).toBeNull();
  expect(document.querySelector(".narrator-dock")).not.toBeNull();
});
