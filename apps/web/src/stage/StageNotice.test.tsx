// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { announce, withdraw } from "../ui/Announcer.tsx";
import type { AwayCause, AwayLevel, ScreenName } from "./connection.ts";
import { StageNotice } from "./StageNotice.tsx";

vi.mock("../ui/Announcer.tsx", () => ({ announce: vi.fn(), withdraw: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const away = (cause: AwayCause, level: AwayLevel, screen: ScreenName = "desktop") =>
  ({ phase: "away", cause, level, screen }) as const;
const notice = () => document.querySelector(".stage-away");

it("shows nothing for a blip, but dips the picture while dot changes screens", () => {
  const view = render(<StageNotice connection={away("stream", "blip")} />);
  expect(notice()).toBeNull();
  view.rerender(<StageNotice connection={away("browser", "blip", "browser")} />);
  expect(notice()).toBeNull();
  view.rerender(<StageNotice connection={away("switch", "blip", "browser")} />);
  expect(notice()?.getAttribute("data-level")).toBe("blip");
  expect(notice()?.textContent).toBe("");
  view.rerender(<StageNotice connection={{ phase: "shown" }} />);
  expect(notice()).toBeNull();
  view.rerender(<StageNotice connection={{ phase: "first" }} />);
  expect(notice()).toBeNull();
});

it.each([
  ["stream", "desktop", "Reconnecting…", "Still reconnecting", true],
  [
    "switch",
    "browser",
    "Switching to the web browser…",
    "Still switching to the web browser",
    true,
  ],
  ["switch", "desktop", "Switching to the desktop…", "Still switching to the desktop", true],
  [
    "browser",
    "browser",
    "The web browser is restarting…",
    "The web browser is still restarting",
    false,
  ],
] as const)(
  "says why a %s gap on the %s lasts, and offers to try again where that helps",
  (cause, on, brief, long, retries) => {
    const onRetry = vi.fn();
    const view = render(<StageNotice connection={away(cause, "brief", on)} onRetry={onRetry} />);
    expect(notice()?.textContent).toBe(brief);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<StageNotice connection={away(cause, "long", on)} onRetry={onRetry} />);
    expect(screen.getByText(long)).toBeTruthy();
    const retry = screen.queryByRole("button", { name: "Try again" });
    expect(!!retry).toBe(retries);
    retry?.click();
    expect(onRetry).toHaveBeenCalledTimes(retries ? 1 : 0);
  },
);

it("announces only a gap that lasts, once, and withdraws it once the picture is back", () => {
  const view = render(<StageNotice connection={away("stream", "brief")} />);
  expect(announce).not.toHaveBeenCalled();
  view.rerender(<StageNotice connection={away("stream", "long")} />);
  view.rerender(<StageNotice connection={away("stream", "long")} />);
  expect(announce).toHaveBeenCalledExactlyOnceWith(
    "stage",
    "Still reconnecting. Your computer keeps running. This is its last picture.",
  );
  expect(withdraw).not.toHaveBeenCalled();
  view.rerender(<StageNotice connection={{ phase: "shown" }} />);
  expect(withdraw).toHaveBeenCalledExactlyOnceWith("stage");
  expect(announce).toHaveBeenCalledOnce();
});
