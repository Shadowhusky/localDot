// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Popover } from "./Popover.tsx";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Share
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        title="Share this replay"
      >
        <p>Anyone with the link can watch it.</p>
        <button type="button">Copy link</button>
        <button type="button">Stop sharing</button>
      </Popover>
    </>
  );
}

function open(): HTMLElement {
  const trigger = screen.getByRole("button", { name: "Share" });
  trigger.focus();
  fireEvent.click(trigger);
  return screen.getByRole("dialog", { name: "Share this replay" });
}

describe("Popover", () => {
  it("is named by its title and moves focus to its first control", () => {
    render(<Harness />);
    open();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy link" }));
  });

  it("keeps Tab inside and gives focus back to its anchor on Escape", () => {
    render(<Harness />);
    open();
    const last = screen.getByRole("button", { name: "Stop sharing" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy link" }));
    fireEvent.keyUp(document.activeElement as HTMLElement, { key: "Tab" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Share" }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("draws its surface without a style element", () => {
    const before = document.querySelectorAll("style").length;
    render(<Harness />);
    open();
    expect(document.querySelectorAll("style")).toHaveLength(before);
  });
});
