// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Popover, triggerProps } from "./Popover.tsx";

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
      <button
        ref={trigger}
        type="button"
        {...triggerProps("dialog", open)}
        onClick={() => setOpen(true)}
      >
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
  it("stays beside its trigger when the page moves the trigger", async () => {
    vi.useRealTimers();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Share" });
    let top = 300;
    trigger.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + 40,
        left: 20,
        right: 120,
        width: 100,
        height: 40,
        x: 20,
        y: top,
      }) as DOMRect;
    const panel = open();
    const frames = () =>
      act(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
    await frames();
    const before = Number.parseFloat(panel.style.top);
    // Moved up by the page settling around it, its size the same.
    top = 260;
    await frames();
    expect(Number.parseFloat(panel.style.top)).toBe(before - 40);
  });

  it("is named by its title and moves focus to its first control", () => {
    render(<Harness />);
    open();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy link" }));
  });

  it("takes the wider size when asked, for a panel with a picture in it", () => {
    render(<Harness />);
    expect(open().getAttribute("data-size")).toBe("md");
    cleanup();
    const trigger = { current: null };
    render(
      <Popover open onClose={() => {}} anchor={trigger} title="Export MP4" size="lg">
        <button type="button">Save</button>
      </Popover>,
    );
    expect(screen.getByRole("dialog", { name: "Export MP4" }).getAttribute("data-size")).toBe("lg");
  });

  it("says it is modal, since it keeps Tab inside and an outside press only closes it", () => {
    render(<Harness />);
    expect(open().getAttribute("aria-modal")).toBe("true");
  });

  it("tells its trigger what it opens and whether it is open, which also keeps it lit", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Share" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    open();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
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
