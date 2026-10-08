// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dot } from "./Dot.tsx";
import { DotView } from "./render/DotView.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function reducedMotionQuery(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", (q: string) => {
    expect(q).toBe("(prefers-reduced-motion: reduce)");
    return query;
  });
  return (matches: boolean) => {
    query.matches = matches;
    for (const fn of listeners) fn();
  };
}

describe("Dot", () => {
  it("is the static glyph up to 18 px and a live view above that", () => {
    const glyph = render(<Dot size={16} />);
    expect(glyph.container.querySelector("svg.dot-glyph")?.getAttribute("width")).toBe("16");
    expect(glyph.container.querySelector(".dot")).toBeNull();
    const live = render(<Dot size={24} />);
    const root = live.container.querySelector<HTMLElement>(".dot");
    expect(root?.dataset.lod).toBe("badge");
    expect(root?.getAttribute("aria-hidden")).toBe("true");
    expect(root?.style.getPropertyValue("--dot-size")).toBe("24px");
  });

  it("follows the reduced-motion preference unless told otherwise", () => {
    const change = reducedMotionQuery(true);
    const reduce = vi.spyOn(DotView.prototype, "setReducedMotion");
    render(<Dot size={24} />);
    expect(reduce).toHaveBeenLastCalledWith(true);
    act(() => change(false));
    expect(reduce).toHaveBeenLastCalledWith(false);
    cleanup();
    reduce.mockClear();
    render(<Dot size={24} reducedMotion={false} />);
    act(() => change(true));
    expect(reduce).not.toHaveBeenCalledWith(true);
  });

  it("passes state and control changes to the view", () => {
    const setState = vi.spyOn(DotView.prototype, "setState");
    const setControl = vi.spyOn(DotView.prototype, "setControl");
    const view = render(<Dot size={24} state="idle" />);
    view.rerender(<Dot size={24} state="acting" control />);
    expect(setState).toHaveBeenLastCalledWith("acting");
    expect(setControl).toHaveBeenLastCalledWith(true);
  });
});
