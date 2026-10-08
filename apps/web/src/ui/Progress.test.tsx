// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Meter } from "./Meter.tsx";
import { Progress } from "./Progress.tsx";

afterEach(cleanup);

describe("Progress", () => {
  it("is a progress bar with its value, its range and how to read it", () => {
    render(
      <Progress
        label="Export progress"
        value={1200}
        max={3000}
        valueText="1,200 of 3,000 frames"
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Export progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("1200");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("3000");
    expect(bar.getAttribute("aria-valuetext")).toBe("1,200 of 3,000 frames");
    expect(bar.style.getPropertyValue("--_value")).toBe("0.4");
  });

  it("keeps a value in range", () => {
    render(<Progress label="Export progress" value={14} max={10} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("10");
    expect(bar.style.getPropertyValue("--_value")).toBe("1");
  });

  it("gives no value while the length is unknown", () => {
    render(<Progress label="Downloading" />);
    const bar = screen.getByRole("progressbar", { name: "Downloading" });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.hasAttribute("data-indeterminate")).toBe(true);
  });

  it("draws a ring, which closes with a check once complete", () => {
    const { rerender } = render(<Progress variant="ring" label="Downloading" value={0.5} />);
    const ring = screen.getByRole("progressbar", { name: "Downloading" });
    expect(ring.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(ring.querySelector(".ui-progress-check")).toBeNull();
    rerender(<Progress variant="ring" label="Downloading" value={1} />);
    expect(ring.querySelector(".ui-progress-check")).not.toBeNull();
    expect(ring.hasAttribute("data-complete")).toBe(true);
  });
});

describe("Meter", () => {
  it("is a meter named by its label", () => {
    render(<Meter label="Primary window" value={62} valueText="62% used" />);
    const meter = screen.getByRole("meter", { name: "Primary window" });
    expect(meter.getAttribute("aria-valuenow")).toBe("62");
    expect(meter.getAttribute("aria-valuetext")).toBe("62% used");
    expect(screen.getByText("62% used")).toBeTruthy();
  });

  it("says in words when it is almost at the limit, not by colour alone", () => {
    render(<Meter label="Secondary window" value={92} valueText="92% used" />);
    const meter = screen.getByRole("meter", { name: "Secondary window" });
    expect(meter.getAttribute("aria-valuetext")).toBe("92% used, almost at limit");
    expect(screen.getByText("Almost at limit · 92% used")).toBeTruthy();
    expect(meter.closest(".ui-meter")?.hasAttribute("data-near")).toBe(true);
  });

  it("shows a percentage when nothing else is given", () => {
    render(<Meter label="Budget" value={3} max={12} />);
    expect(screen.getByText("25%")).toBeTruthy();
  });
});
