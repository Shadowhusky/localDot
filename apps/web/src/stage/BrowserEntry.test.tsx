// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserEntry } from "./BrowserEntry.tsx";
import type { StageFront } from "./useStageFront.ts";

afterEach(cleanup);

const front = (over: Partial<StageFront>): StageFront => ({
  screen: "browser",
  dot: "browser",
  browser: undefined,
  problem: null,
  pick: vi.fn(),
  route: (input) => input,
  ...over,
});

it("minimises the web browser's window from the menu bar, and shows it again", () => {
  const open = front({});
  const view = render(<BrowserEntry front={open} holding={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Minimise the web browser" }));
  expect(open.pick).toHaveBeenCalledWith("desktop");
  const minimised = front({ screen: "desktop", dot: "desktop" });
  view.rerender(<BrowserEntry front={minimised} holding={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Show the web browser" }));
  expect(minimised.pick).toHaveBeenCalledWith("browser");
});

it("marks the window dot is working in while it is minimised", () => {
  render(<BrowserEntry front={front({ screen: "desktop" })} holding={false} />);
  const entry = screen.getByRole("button", { name: "Show the web browser, where dot is working" });
  expect(entry.hasAttribute("data-dot")).toBe(true);
  expect(entry.hasAttribute("data-open")).toBe(false);
  expect(entry.textContent).toBe("Web browser");
});

it("is the only way between the two: no Desktop or Web browser switch", () => {
  render(<BrowserEntry front={front({})} holding={false} />);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /desktop/i })).toBeNull();
});

it("says plainly what the window and the desktop don't share", () => {
  render(<BrowserEntry front={front({})} holding={false} />);
  expect(screen.getByRole("button").getAttribute("aria-description")).toMatch(
    /copied text and drags don't cross/,
  );
});

it("leaves the keys with the computer when a pointer presses it", () => {
  render(<BrowserEntry front={front({})} holding />);
  const entry = screen.getByRole("button", { name: "Minimise the web browser" });
  const press = createEvent.mouseDown(entry);
  fireEvent(entry, press);
  expect(press.defaultPrevented).toBe(true);
});
