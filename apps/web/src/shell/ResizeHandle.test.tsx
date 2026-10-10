// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dragWidth, type PanelWidth, readWidth, rubberBand, saveWidth } from "./panel-width.ts";
import { ResizeHandle } from "./ResizeHandle.tsx";

const PANEL: PanelWidth = { key: "test.width", initial: 300, min: 200, max: 500, reserve: 0 };

function Page() {
  return <ResizeHandle panel={PANEL} property="--panel-w" label="Panel width" />;
}

const handle = () => screen.getByRole("separator", { name: "Panel width" });
const shown = () => document.documentElement.style.getPropertyValue("--panel-w");

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));
  HTMLElement.prototype.setPointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResizeHandle", () => {
  it("is a focusable vertical separator that sizes its panel from the saved width", () => {
    saveWidth(PANEL, 360);
    render(<Page />);
    const edge = handle();
    expect(edge.tabIndex).toBe(0);
    expect(edge.getAttribute("aria-orientation")).toBe("vertical");
    expect(edge.getAttribute("aria-valuenow")).toBe("360");
    expect(edge.getAttribute("aria-valuemin")).toBe("200");
    expect(edge.getAttribute("aria-valuemax")).toBe("500");
    expect(shown()).toBe("360px");
  });

  it("moves 16 px per arrow and 64 px with Shift, within its limits, and keeps the width", () => {
    render(<Page />);
    const edge = handle();
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(edge.getAttribute("aria-valuenow")).toBe("316");
    fireEvent.keyDown(edge, { key: "ArrowRight", shiftKey: true });
    expect(edge.getAttribute("aria-valuenow")).toBe("252");
    for (let n = 0; n < 4; n++) fireEvent.keyDown(edge, { key: "ArrowRight", shiftKey: true });
    expect(edge.getAttribute("aria-valuenow")).toBe("200");
    expect(shown()).toBe("200px");
    expect(readWidth(PANEL)).toBe(200);
  });

  it("follows the pointer from where it was grabbed, gives softly past a limit and settles inside it", () => {
    render(<Page />);
    const edge = handle();
    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: 600 });
    expect(edge.hasAttribute("data-dragging")).toBe(true);
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 540 });
    expect(edge.getAttribute("aria-valuenow")).toBe("360");
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 300 });
    const stretched = Number(edge.getAttribute("aria-valuenow"));
    expect(stretched).toBeGreaterThan(500);
    expect(stretched).toBeLessThan(560);
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: 300 });
    expect(edge.hasAttribute("data-dragging")).toBe(false);
    expect(edge.getAttribute("aria-valuenow")).toBe("500");
    expect(readWidth(PANEL)).toBe(500);
  });

  it("goes back to its default width on a double-click", () => {
    saveWidth(PANEL, 420);
    render(<Page />);
    fireEvent.doubleClick(handle());
    expect(handle().getAttribute("aria-valuenow")).toBe("300");
    expect(shown()).toBe("300px");
    expect(localStorage.getItem(PANEL.key)).toBeNull();
  });

  it("restores the saved width after a smaller window temporarily constrains it", () => {
    vi.stubGlobal("innerWidth", 1000);
    saveWidth(PANEL, 460);
    const view = render(<Page />);
    vi.stubGlobal("innerWidth", 320);
    fireEvent(window, new Event("resize"));
    expect(shown()).toBe("320px");
    expect(readWidth(PANEL)).toBe(460);
    vi.stubGlobal("innerWidth", 1000);
    fireEvent(window, new Event("resize"));
    expect(shown()).toBe("460px");
    view.unmount();
    render(<Page />);
    expect(shown()).toBe("460px");
  });

  it("lets go of the width it set once it is gone", () => {
    const view = render(<Page />);
    expect(shown()).toBe("300px");
    view.unmount();
    expect(shown()).toBe("");
  });
});

describe("panel widths", () => {
  it("rubber-bands an overshoot toward a soft reach", () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(40)).toBeLessThan(40);
    expect(rubberBand(400)).toBeGreaterThan(rubberBand(40));
    expect(rubberBand(10_000)).toBeLessThan(60);
    expect(rubberBand(-40)).toBe(-rubberBand(40));
    expect(dragWidth(300, 50, { min: 200, max: 500 })).toBe(350);
    expect(dragWidth(300, -200, { min: 200, max: 500 })).toBeGreaterThan(160);
  });

  it("falls back to the default width when storage is out of reach", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readWidth(PANEL)).toBe(300);
    expect(() => saveWidth(PANEL, 400)).not.toThrow();
    vi.restoreAllMocks();
  });
});
