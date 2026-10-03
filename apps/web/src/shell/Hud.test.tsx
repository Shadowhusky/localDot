// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hud } from "./Hud.tsx";

afterEach(cleanup);

describe("paused HUD", () => {
  it("offers Resume and Stop, keeps focus through pending changes, and blocks repeated actions", () => {
    const onResume = vi.fn();
    const onStop = vi.fn();
    const props = {
      hud: {
        label: "Paused",
        caption: "Frozen.",
        action: { kind: "resume" as const, enabled: true },
        live: false,
      },
      onStart: vi.fn(),
      onStop,
      onStopSession: vi.fn(),
      onResume,
      onRetry: vi.fn(),
    };
    const view = render(<Hud {...props} />);
    const resume = screen.getByRole("button", { name: "Resume computer" });
    const stop = screen.getByRole("button", { name: "Stop computer" });
    fireEvent.click(resume);
    fireEvent.click(stop);
    expect(onResume).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    resume.focus();
    view.rerender(
      <Hud {...props} hud={{ ...props.hud, action: { kind: "resume", enabled: false } }} />,
    );
    expect(document.activeElement).toBe(resume);
    expect(resume.getAttribute("aria-disabled")).toBe("true");
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(resume);
    fireEvent.click(stop);
    expect(onResume).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Start computer" })).toBeNull();
  });
});
