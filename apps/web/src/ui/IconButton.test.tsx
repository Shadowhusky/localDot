// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "./IconButton.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function hover(element: HTMLElement) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
  act(() => {
    vi.advanceTimersByTime(500);
  });
  return document.querySelector<HTMLElement>(".ui-tooltip");
}

describe("IconButton", () => {
  it("is named by its label and draws a hidden 16 px icon", () => {
    render(<IconButton label="Settings" icon="sliders-horizontal" />);
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.dataset.size).toBe("28");
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("width")).toBe("16");
  });

  it("shows its label and shortcut on hover without describing itself twice", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<IconButton label="Stop" icon="square" kbd={["Mod", "Shift", "."]} />);
    const button = screen.getByRole("button", { name: "Stop" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+.");
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    const tooltip = hover(button);
    expect(tooltip?.querySelector(".ui-tooltip-text")?.textContent).toBe("Stop");
    expect(tooltip?.querySelector("kbd [aria-hidden]")?.textContent).toBe("⌘⇧.");
  });

  it("spells the shortcut out with Ctrl away from Apple devices", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    render(<IconButton label="Stop" icon="square" kbd={["Mod", "Shift", "."]} />);
    const button = screen.getByRole("button", { name: "Stop" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+.");
    expect(hover(button)?.querySelector("kbd [aria-hidden]")?.textContent).toBe("Ctrl+Shift+.");
  });

  it("stays focusable while unavailable, and its tooltip gives the reason", () => {
    const onClick = vi.fn();
    render(
      <IconButton
        label="Replay"
        icon="play"
        onClick={onClick}
        disabledReason="Replays appear after your first task"
      />,
    );
    const button = screen.getByRole("button", {
      name: "Replay",
      description: "Replays appear after your first task",
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(hover(button)?.textContent).toBe("ReplayReplays appear after your first task");
  });

  it("shows the reason when a finger taps it, since touch has no hover", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    render(
      <IconButton label="Export" icon="download" disabledReason="Export needs Chrome or Edge" />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Export" }), {
      pointerType: "touch",
      button: 0,
    });
    expect(document.querySelector(".ui-tooltip")?.textContent).toContain(
      "Export needs Chrome or Edge",
    );
  });

  it("keeps the reason up when a click takes focus off the button, as Safari does", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    render(
      <IconButton label="Export" icon="download" disabledReason="Export needs Chrome or Edge" />,
    );
    const button = screen.getByRole("button", { name: "Export" });
    button.focus();
    fireEvent.pointerDown(button, { pointerType: "mouse", button: 0 });
    fireEvent.blur(button);
    fireEvent.pointerUp(button, { pointerType: "mouse", button: 0 });
    expect(document.querySelector(".ui-tooltip:not([data-closing])")?.textContent).toContain(
      "Export needs Chrome or Edge",
    );
  });

  it("presses on pointer-down", () => {
    render(<IconButton label="Pause" icon="pause" size={32} />);
    const button = screen.getByRole("button", { name: "Pause" });
    expect(button.dataset.size).toBe("32");
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    expect(button.dataset.pressed).toBe("squeeze");
    fireEvent.pointerUp(button, { button: 0, pointerType: "mouse" });
    expect(button.dataset.pressed).toBeUndefined();
  });
});
