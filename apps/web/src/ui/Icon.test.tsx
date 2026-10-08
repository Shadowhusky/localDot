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
  "square",
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
  "sliders-horizontal",
  "copy",
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

  it("keeps a 1.5 px stroke at every size", () => {
    for (const [size, stroke] of [
      [12, "3"],
      [16, "2.25"],
      [20, "1.8"],
    ] as const) {
      const { container, unmount } = render(<Icon name="check" size={size} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("width")).toBe(String(size));
      expect(svg?.getAttribute("stroke-width")).toBe(stroke);
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
