// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collapse, Disclosure } from "./Disclosure.tsx";
import { Meter } from "./Meter.tsx";
import { ScrollArea } from "./ScrollArea.tsx";
import { StatusGlyph } from "./StatusGlyph.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("StatusGlyph", () => {
  it("names every state and draws the turning arc only while in progress", () => {
    render(
      <>
        {(["todo", "doing", "done", "failed", "skipped"] as const).map((state) => (
          <StatusGlyph key={state} state={state} />
        ))}
        <StatusGlyph state="todo" label="Not confirmed" />
      </>,
    );
    expect(screen.getAllByRole("img").map((glyph) => glyph.getAttribute("aria-label"))).toEqual([
      "Not started",
      "In progress",
      "Done",
      "Failed",
      "Skipped",
      "Not confirmed",
    ]);
    expect(document.querySelectorAll(".ui-status-arc")).toHaveLength(1);
    expect(document.querySelectorAll(".ui-status-check")).toHaveLength(1);
  });
});

describe("Disclosure", () => {
  it("mounts its content when opened, keeps it while folding, and folds on Escape", () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    render(
      <Disclosure
        summary="Earlier steps"
        meta="12 steps"
        onOpenChange={(open) => changes.push(open)}
      >
        <p>Inside</p>
      </Disclosure>,
    );
    const trigger = screen.getByRole("button", { name: "Earlier steps 12 steps" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Inside")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
    expect(panel?.hasAttribute("inert")).toBe(false);
    const inside = screen.getByText("Inside");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.hasAttribute("inert")).toBe(true);
    expect(screen.getByText("Inside")).toBe(inside);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText("Inside")).toBeNull();
    expect(changes).toEqual([true, false]);
  });

  it("lets focus rings reach past its edge only once fully open", () => {
    const { rerender } = render(<Collapse open={false}>content</Collapse>);
    const collapse = document.querySelector(".ui-collapse") as HTMLElement;
    rerender(<Collapse open>content</Collapse>);
    expect(collapse.hasAttribute("data-settled")).toBe(false);
    fireEvent.transitionEnd(collapse);
    expect(collapse.hasAttribute("data-settled")).toBe(true);
    rerender(<Collapse open={false}>content</Collapse>);
    expect(collapse.hasAttribute("data-settled")).toBe(false);
  });
});

describe("Meter", () => {
  it("reports its value and marks the last tenth", () => {
    render(
      <>
        <Meter value={40} label="Window used" />
        <Meter value={95} label="Week used" />
      </>,
    );
    const [low, high] = screen.getAllByRole("meter");
    expect(low?.getAttribute("aria-valuenow")).toBe("40");
    expect(low?.hasAttribute("data-high")).toBe(false);
    expect(high?.hasAttribute("data-high")).toBe(true);
  });
});

describe("ScrollArea", () => {
  it("marks an edge only while content lies past it", () => {
    render(
      <ScrollArea aria-label="List">
        <div>rows</div>
      </ScrollArea>,
    );
    const area = screen.getByLabelText("List");
    Object.defineProperties(area, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    area.scrollTop = 0;
    fireEvent.scroll(area);
    expect([area.hasAttribute("data-edge-top"), area.hasAttribute("data-edge-bottom")]).toEqual([
      false,
      true,
    ]);
    area.scrollTop = 800;
    fireEvent.scroll(area);
    expect([area.hasAttribute("data-edge-top"), area.hasAttribute("data-edge-bottom")]).toEqual([
      true,
      false,
    ]);
  });
});
