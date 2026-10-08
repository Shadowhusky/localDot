// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatKeys, Kbd } from "./Kbd.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("formatKeys", () => {
  it("draws Apple's modifier glyphs on a Mac, run together", () => {
    expect(formatKeys(["Mod", "Shift", "."], true)).toEqual({
      label: "⌘⇧.",
      spoken: "Command Shift .",
      aria: "Meta+Shift+.",
    });
    expect(formatKeys(["Mod", "Enter"], true).label).toBe("⌘↩");
    expect(formatKeys(["Alt", "k"], true)).toEqual({
      label: "⌥K",
      spoken: "Option K",
      aria: "Alt+k",
    });
  });

  it("spells the keys out elsewhere, joined with plus signs", () => {
    expect(formatKeys(["Mod", "Shift", "."], false)).toEqual({
      label: "Ctrl+Shift+.",
      spoken: "Control Shift .",
      aria: "Control+Shift+.",
    });
    expect(formatKeys(["Escape"], false)).toEqual({
      label: "Esc",
      spoken: "Escape",
      aria: "Escape",
    });
  });
});

describe("Kbd", () => {
  it("shows the glyphs and reads the names", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const { container } = render(<Kbd keys={["Mod", "Shift", "."]} />);
    const kbd = container.querySelector("kbd");
    expect(kbd?.className).toBe("ui-kbd");
    expect(kbd?.querySelector("[aria-hidden='true']")?.textContent).toBe("⌘⇧.");
    expect(kbd?.querySelector(".ui-visually-hidden")?.textContent).toBe("Command Shift .");
  });

  it("knows a Mac from the platform Chromium reports, which is spelled macOS", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("");
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: { platform: "macOS" },
    });
    try {
      const { container } = render(<Kbd keys={["Mod", "K"]} />);
      expect(container.querySelector("kbd [aria-hidden='true']")?.textContent).toBe("⌘K");
    } finally {
      delete (navigator as { userAgentData?: unknown }).userAgentData;
    }
  });

  it("reads the platform the page runs on", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const { container } = render(<Kbd keys={["Mod", "K"]} />);
    expect(container.querySelector("kbd [aria-hidden='true']")?.textContent).toBe("Ctrl+K");
  });
});
