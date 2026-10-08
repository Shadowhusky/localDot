// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DotView } from "../dot/render/DotView.ts";
import { Mascot } from "./Mascot.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Mascot", () => {
  it("is dot's live 24 px badge in the HUD, its ball filling the slot", () => {
    const { container } = render(
      <div className="app">
        <div className="hud">
          <Mascot />
        </div>
      </div>,
    );
    const badge = container.querySelector<HTMLElement>(".hud .mascot > .dot");
    expect(badge?.dataset.lod).toBe("badge");
    expect(badge?.style.getPropertyValue("--dot-size")).toBe("24px");
    expect(badge?.style.margin).toBe("-3px");
    expect(badge?.querySelectorAll(".dot-eye")).toHaveLength(2);
  });

  it("stays the static glyph outside the HUD", () => {
    const { container } = render(
      <span className="brand">
        <Mascot />
      </span>,
    );
    expect(container.querySelector(".mascot > svg.dot-glyph")).not.toBeNull();
    expect(container.querySelector(".dot")).toBeNull();
  });

  it("acts under the xenon rim while dot has control and rests while paused", async () => {
    const setState = vi.spyOn(DotView.prototype, "setState");
    const setControl = vi.spyOn(DotView.prototype, "setControl");
    const { container } = render(
      <div className="app">
        <div className="hud">
          <Mascot />
        </div>
      </div>,
    );
    const app = container.querySelector(".app") as HTMLElement;
    const hud = container.querySelector(".hud") as HTMLElement;
    const flush = () => act(() => Promise.resolve());
    app.className = "app control";
    await flush();
    expect(setState).toHaveBeenLastCalledWith("acting");
    expect(setControl).toHaveBeenLastCalledWith(true);
    app.className = "app";
    hud.className = "hud paused";
    await flush();
    expect(setState).toHaveBeenLastCalledWith("resting");
    expect(setControl).toHaveBeenLastCalledWith(false);
  });
});
