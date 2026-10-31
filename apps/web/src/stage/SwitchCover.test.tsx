// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { announce, withdraw } from "../ui/Announcer.tsx";
import { SwitchCover } from "./SwitchCover.tsx";
import type { StageSwitch } from "./stage-switch.ts";

vi.mock("../ui/Announcer.tsx", () => ({ announce: vi.fn(), withdraw: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const at = (phase: StageSwitch["phase"]): StageSwitch => ({
  to: "01JXYZ0000000000000000CONV",
  title: "Plan a picnic",
  phase,
  turn: 1,
});
const cover = () => document.querySelector(".switch-cover");

it("shows nothing while the picture on the stage stays", () => {
  const view = render(<SwitchCover state={null} onShowComputer={() => {}} />);
  expect(cover()).toBeNull();
  view.rerender(<SwitchCover state={at("pending")} onShowComputer={() => {}} />);
  expect(cover()).toBeNull();
});

it("covers the stage with a likeness of a screen under the conversation's name", () => {
  render(<SwitchCover state={at("covering")} onShowComputer={() => {}} />);
  expect(cover()?.querySelector(".ui-skeleton[aria-busy='true']")).not.toBeNull();
  expect(cover()?.querySelector(".switch-cover-title")?.textContent).toBe("Plan a picnic");
  // Only a late screen is news to a screen reader; the thread already says which conversation.
  expect(cover()?.querySelector(".switch-cover-screen")?.getAttribute("aria-hidden")).toBe("true");
  expect(announce).not.toHaveBeenCalled();
});

it("says a screen that never came is late, and shows the computer at a press", () => {
  const show = vi.fn();
  const view = render(<SwitchCover state={at("slow")} onShowComputer={show} />);
  expect(screen.getByText("This conversation's screen is taking longer than usual")).toBeTruthy();
  expect(announce).toHaveBeenCalledWith(
    "stage-switch",
    "This conversation's screen is taking longer than usual. Its picture hasn't come through yet.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Show the computer" }));
  expect(show).toHaveBeenCalledOnce();
  view.rerender(<SwitchCover state={null} onShowComputer={show} />);
  expect(withdraw).toHaveBeenCalledWith("stage-switch");
});
