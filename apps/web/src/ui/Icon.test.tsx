// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Icon } from "./Icon.tsx";
import { ICONS, type IconName } from "./icons.ts";

afterEach(cleanup);

// The set the UI plan names (§4.2), so later screens can count on each one, plus the kit's own:
// search, for the Combobox's search field.
const PLANNED: IconName[] = [
  "search",
  "check",
  "x",
  // Not in the plan's list: the Back of a sheet's nested page (T08).
  "chevron-left",
  "chevron-right",
  "chevron-down",
  "chevron-up",
  "hand",
  "stop",
  "pause",
  "play",
  "skip-back",
  "skip-forward",
  "keyboard",
  "mouse-pointer-click",
  "app-window",
  "type",
  "file",
  "paperclip",
  "arrow-up",
  "arrow-down",
  "arrow-left",
  "arrow-right",
  "key-round",
  "settings",
  "sliders-horizontal",
  "copy",
  "clipboard-paste",
  "download",
  "undo-2",
  "terminal",
  "file-diff",
  "circle-alert",
  "lock",
  "more-horizontal",
  "eye",
  "eye-off",
  "globe",
  "monitor",
  // Added by the master design (design-v2 §6).
  "power",
  "compose",
  "list",
  "history",
  "expand",
  "shrink",
  "mouse-right",
  "shield",
  "book",
  "contrast",
  "cpu",
  "check-circle",
  "continue",
  "share",
  "filter",
  "back-10",
  "forward-10",
  "bell",
  "trash",
  "chevrons-up-down",
  "info",
  // Settings: Spending and the audit log (design-v2 §11 I, J).
  "chart",
  "file-text",
  // First-run setup: the ChatGPT plan and coding plans (design-v2 §11 A0).
  "message-circle",
  "code",
];

describe("Icon", () => {
  it("vendors every outline the plan names, and nothing else", () => {
    expect(Object.keys(ICONS).sort()).toEqual([...PLANNED].sort());
  });

  it("draws every outline on the 24 px grid", () => {
    for (const name of PLANNED) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("viewBox"), name).toBe("0 0 24 24");
      expect(svg?.children.length, name).toBe(ICONS[name].length);
      unmount();
    }
  });

  it("draws a 1.6 stroke on the 24 px grid at every size", () => {
    for (const size of [12, 16, 22] as const) {
      const { container, unmount } = render(<Icon name="check" size={size} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("width")).toBe(String(size));
      expect(svg?.getAttribute("stroke-width")).toBe("1.6");
      unmount();
    }
  });

  it("is decoration unless it is given a label", () => {
    const { container } = render(
      <>
        <Icon name="lock" />
        <Icon name="circle-alert" label="Problem" />
      </>,
    );
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("img", { name: "Problem" }).tagName).toBe("svg");
  });
});
