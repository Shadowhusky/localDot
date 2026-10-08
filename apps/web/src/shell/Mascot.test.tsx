// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DotView } from "../dot/render/DotView.ts";
import { Mascot } from "./Mascot.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Mascot", () => {
  it("is dot's live 24 px badge when given a pose, its ball filling the slot", () => {
    const { container } = render(<Mascot state="idle" />);
    const badge = container.querySelector<HTMLElement>(".mascot > .dot");
    expect(badge?.dataset.lod).toBe("badge");
    expect(badge?.style.getPropertyValue("--dot-size")).toBe("24px");
    expect(badge?.style.margin).toBe("-3px");
    expect(badge?.querySelectorAll(".dot-eye")).toHaveLength(2);
  });

  it("stays the static glyph without a pose", () => {
    const { container } = render(
      <span className="brand">
        <Mascot />
      </span>,
    );
    expect(container.querySelector(".mascot > svg.dot-glyph")).not.toBeNull();
    expect(container.querySelector(".dot")).toBeNull();
  });

  it("takes the pose and the xenon rim it is given", () => {
    const setState = vi.spyOn(DotView.prototype, "setState");
    const setControl = vi.spyOn(DotView.prototype, "setControl");
    const view = render(<Mascot state="thinking" control />);
    expect(setState).toHaveBeenLastCalledWith("thinking");
    expect(setControl).toHaveBeenLastCalledWith(true);
    view.rerender(<Mascot state="your-turn" />);
    expect(setState).toHaveBeenLastCalledWith("your-turn");
    expect(setControl).toHaveBeenLastCalledWith(false);
    expect(view.container.querySelector(".mascot")?.getAttribute("data-state")).toBe("your-turn");
  });
});
