// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip.tsx";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function popup(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ui-tooltip:not([data-closing])");
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function Pair() {
  return (
    <>
      <Tooltip content="Copies a link to this replay">
        <button type="button">Copy link</button>
      </Tooltip>
      <Tooltip content="Saves the replay as a video" kbd={["Mod", "E"]}>
        <button type="button">Export</button>
      </Tooltip>
    </>
  );
}

describe("Tooltip", () => {
  it("opens 500 ms after the pointer arrives and closes when it leaves", () => {
    render(<Pair />);
    const copy = screen.getByRole("button", { name: "Copy link" });
    fireEvent.pointerEnter(copy, { pointerType: "mouse" });
    wait(499);
    expect(popup()).toBeNull();
    wait(1);
    expect(popup()?.textContent).toBe("Copies a link to this replay");
    fireEvent.pointerLeave(copy, { pointerType: "mouse" });
    expect(popup()).toBeNull();
    expect(document.querySelector(".ui-tooltip")).toBeNull();
    wait(400);
    expect(document.querySelector(".ui-tooltip")).toBeNull();
  });

  it.each([200, 20])(
    "keeps the gap and tooltip hoverable, and closes outside without a timer (top %s)",
    (top) => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
        new DOMRect(100, top, 40, 20),
      );
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(120);
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(40);
      render(<Pair />);
      fireEvent.pointerEnter(screen.getByRole("button", { name: "Copy link" }), {
        pointerType: "mouse",
      });
      wait(500);
      const gapY = top >= 64 ? top - 4 : top + 24;
      const tipY = top >= 64 ? top - 28 : top + 48;
      const move = (x: number, y: number) =>
        fireEvent(
          document,
          new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true }),
        );
      move(120, gapY);
      expect(popup()).not.toBeNull();
      wait(1500);
      expect(popup()).not.toBeNull();
      move(120, tipY);
      expect(popup()).not.toBeNull();
      move(120, gapY);
      expect(popup()).not.toBeNull();
      // The neighbouring area at the same height is not part of the safe corridor.
      move(300, gapY);
      expect(document.querySelector(".ui-tooltip")).toBeNull();
    },
  );

  it("does not open when the pointer passes through quickly", () => {
    render(<Pair />);
    const copy = screen.getByRole("button", { name: "Copy link" });
    fireEvent.pointerEnter(copy, { pointerType: "mouse" });
    wait(200);
    fireEvent.pointerLeave(copy, { pointerType: "mouse" });
    wait(1000);
    expect(document.querySelector(".ui-tooltip")).toBeNull();
  });

  it("opens at once while the pointer moves from one trigger to the next", () => {
    render(<Pair />);
    const copy = screen.getByRole("button", { name: "Copy link" });
    const exportButton = screen.getByRole("button", { name: "Export" });
    fireEvent.pointerEnter(copy, { pointerType: "mouse" });
    wait(500);
    fireEvent.pointerLeave(copy, { pointerType: "mouse" });
    fireEvent.pointerEnter(exportButton, { pointerType: "mouse" });
    expect(popup()?.textContent).toContain("Saves the replay as a video");
    expect(popup()?.dataset.instant).toBe("");
    expect(document.querySelectorAll(".ui-tooltip")).toHaveLength(1);
  });

  it("waits again once the pointer has rested away from every trigger", () => {
    render(<Pair />);
    const copy = screen.getByRole("button", { name: "Copy link" });
    const exportButton = screen.getByRole("button", { name: "Export" });
    fireEvent.pointerEnter(copy, { pointerType: "mouse" });
    wait(500);
    fireEvent.pointerLeave(copy, { pointerType: "mouse" });
    wait(1000);
    fireEvent.pointerEnter(exportButton, { pointerType: "mouse" });
    expect(popup()).toBeNull();
    wait(500);
    expect(popup()?.dataset.instant).toBeUndefined();
  });

  it("never opens for a finger resting on the trigger", () => {
    render(<Pair />);
    const copy = screen.getByRole("button", { name: "Copy link" });
    fireEvent.pointerEnter(copy, { pointerType: "touch" });
    fireEvent.pointerDown(copy, { pointerType: "touch", button: 0 });
    wait(1000);
    expect(document.querySelector(".ui-tooltip")).toBeNull();
  });

  it("describes its trigger while closed, and keeps the visible copy out of the reading order", () => {
    render(<Pair />);
    expect(screen.getByRole("button", { name: "Copy link" })).toBe(
      screen.getByRole("button", { description: "Copies a link to this replay" }),
    );
    const exportButton = screen.getByRole("button", { name: "Export" });
    fireEvent.pointerEnter(exportButton, { pointerType: "mouse" });
    wait(500);
    expect(popup()?.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives its trigger the shortcut it shows", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<Pair />);
    const exportButton = screen.getByRole("button", { name: "Export" });
    expect(exportButton.getAttribute("aria-keyshortcuts")).toBe("Meta+E");
    fireEvent.pointerEnter(exportButton, { pointerType: "mouse" });
    wait(500);
    expect(popup()?.querySelector("kbd")?.textContent).toContain("⌘E");
  });

  it("closes on Escape and keeps the key from closing what lies beneath", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(<Pair />);
    const copy = screen.getByRole("button", { name: "Copy link" });
    fireEvent.pointerEnter(copy, { pointerType: "mouse" });
    wait(500);
    fireEvent.keyDown(copy, { key: "Escape" });
    expect(popup()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(copy, { key: "Escape" });
    expect(outer).toHaveBeenCalledOnce();
    document.removeEventListener("keydown", outer);
  });

  it("closes on Escape while the pointer rests on a trigger that has no focus", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(<Pair />);
    const copy = screen.getByRole("button", { name: "Copy link" });
    fireEvent.pointerEnter(copy, { pointerType: "mouse" });
    wait(500);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(popup()).toBeNull();
    expect(outer).toHaveBeenCalledOnce();
    document.removeEventListener("keydown", outer);
  });

  it("closes when the trigger is clicked", () => {
    render(<Pair />);
    const copy = screen.getByRole("button", { name: "Copy link" });
    fireEvent.pointerEnter(copy, { pointerType: "mouse" });
    wait(500);
    fireEvent.pointerDown(copy, { pointerType: "mouse", button: 0 });
    expect(popup()).toBeNull();
  });

  it("closes when the page scrolls", () => {
    render(<Pair />);
    const copy = screen.getByRole("button", { name: "Copy link" });
    fireEvent.pointerEnter(copy, { pointerType: "mouse" });
    wait(500);
    fireEvent.scroll(document);
    expect(document.querySelector(".ui-tooltip")).toBeNull();
  });

  it("closes when a scroller around the trigger scrolls", () => {
    render(
      <div data-testid="rail">
        <Pair />
      </div>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Copy link" }), {
      pointerType: "mouse",
    });
    wait(500);
    fireEvent.scroll(screen.getByTestId("rail"));
    expect(document.querySelector(".ui-tooltip")).toBeNull();
  });

  it("stays open while another part of the page scrolls", () => {
    render(
      <>
        <Pair />
        <div data-testid="conversation" />
      </>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Copy link" }), {
      pointerType: "mouse",
    });
    wait(500);
    fireEvent.scroll(screen.getByTestId("conversation"));
    expect(popup()?.textContent).toBe("Copies a link to this replay");
  });

  it("stays centred on its trigger when what it says changes while open", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(300, 200, 28, 28),
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return (this.textContent?.length ?? 0) * 8;
    });
    const pause = (content: string) => (
      <Tooltip content={content}>
        <button type="button">Pause</button>
      </Tooltip>
    );
    const { rerender } = render(pause("Pause after this step"));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Pause" }), {
      pointerType: "mouse",
    });
    wait(500);
    const centre = () => {
      const element = popup();
      if (!element) throw new Error("no tooltip");
      return Number.parseFloat(element.style.left) + element.offsetWidth / 2;
    };
    expect(centre()).toBe(314);
    rerender(pause("Continue"));
    expect(popup()?.textContent).toBe("Continue");
    expect(centre()).toBe(314);
  });

  it("keeps the trigger's own handlers", () => {
    const onPointerEnter = vi.fn();
    render(
      <Tooltip content="Pause after this step">
        <button type="button" onPointerEnter={onPointerEnter}>
          Pause
        </button>
      </Tooltip>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Pause" }), {
      pointerType: "mouse",
    });
    expect(onPointerEnter).toHaveBeenCalledOnce();
  });
});
