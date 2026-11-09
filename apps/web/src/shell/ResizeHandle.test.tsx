// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dragWidth,
  type PanelWidth,
  readWidth,
  rubberBand,
  saveWidth,
  widthLimits,
} from "./panel-width.ts";
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

  it("widens to the right on a panel's right edge, by pointer and by arrow", () => {
    render(<ResizeHandle panel={PANEL} property="--panel-w" label="Panel width" side="right" />);
    const edge = handle();
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(edge.getAttribute("aria-valuenow")).toBe("316");
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(edge.getAttribute("aria-valuenow")).toBe("300");
    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 360 });
    expect(edge.getAttribute("aria-valuenow")).toBe("360");
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: 360 });
    expect(readWidth(PANEL)).toBe(360);
  });

  it("leaves the stage its room beside what else is on the page, with no cap of its own", () => {
    const panel = { key: "test.open", initial: 300, min: 200, reserve: 300 };
    expect(widthLimits(panel, 1200).max).toBe(900);
    expect(widthLimits(panel, 1200, 56).max).toBe(844);
    expect(widthLimits(panel, 2560, 56).max).toBe(2204);
    expect(widthLimits(panel, 400).max).toBe(200);
    expect(widthLimits({ ...panel, max: 420 }, 2560).max).toBe(420);
  });

  it("makes room when what shares the page opens, and takes it back when it closes", () => {
    const other: PanelWidth = { key: "test.other", initial: 256, min: 100, reserve: 0 };
    vi.stubGlobal("innerWidth", 1000);
    const panel = { ...PANEL, max: undefined, reserve: 300 };
    saveWidth(panel, 640);
    const page = (beside: PanelWidth | number) => (
      <ResizeHandle panel={panel} property="--panel-w" label="Panel width" beside={beside} />
    );
    const view = render(page(56));
    expect(handle().getAttribute("aria-valuenow")).toBe("640");
    expect(handle().getAttribute("aria-valuemax")).toBe("644");
    view.rerender(page(other));
    expect(handle().getAttribute("aria-valuenow")).toBe("444");
    expect(handle().getAttribute("aria-valuemax")).toBe("444");
    expect(readWidth(panel)).toBe(640);
    view.rerender(page(56));
    expect(handle().getAttribute("aria-valuenow")).toBe("640");
  });

  it("reads what the other panel is held at, not what it has saved", () => {
    vi.stubGlobal("innerWidth", 1000);
    const other: PanelWidth = { key: "test.other", initial: 256, min: 100, reserve: 600 };
    saveWidth(other, 500);
    const panel = { ...PANEL, max: undefined, reserve: 300 };
    render(
      <>
        <ResizeHandle panel={other} property="--other-w" label="Other width" />
        <ResizeHandle panel={panel} property="--panel-w" label="Panel width" beside={other} />
      </>,
    );
    expect(screen.getByRole("separator", { name: "Other width" }).ariaValueNow).toBe("400");
    expect(handle().getAttribute("aria-valuemax")).toBe("300");
  });

  it("saves nothing for a press that moved nothing", () => {
    vi.stubGlobal("innerWidth", 1000);
    saveWidth(PANEL, 460);
    render(
      <ResizeHandle panel={{ ...PANEL, reserve: 600 }} property="--panel-w" label="Panel width" />,
    );
    const edge = handle();
    expect(edge.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: 300 });
    expect(readWidth(PANEL)).toBe(460);
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
