// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Announcer from "./Announcer.tsx";
import { StepSlider, type StepSliderProps } from "./StepSlider.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Memory on a 7.6 GB Docker: 2 to 5.5 GB in half steps.
function Memory(props: Partial<StepSliderProps>) {
  const [value, setValue] = useState(props.value ?? 4);
  return (
    <StepSlider
      label="Memory"
      value={value}
      min={2}
      max={5.5}
      end={7.6}
      step={0.5}
      valueText={(gb) => `${gb} GB`}
      onValueChange={(next) => {
        setValue(next);
        props.onValueChange?.(next);
      }}
      endLabel="7.6 GB"
      endTip="Docker gives localDot 7.6 GB."
      lowReason="dot's computer needs at least 2 GB."
      highReason="Other dots and Docker itself hold the rest."
      marks={[{ from: 0, to: 1, tone: "used" }]}
    >
      1 GB in use
    </StepSlider>
  );
}

const slider = () => screen.getByRole("slider", { name: "Memory" }) as HTMLInputElement;
const press = (key: string) => fireEvent.keyDown(slider(), { key });

describe("StepSlider", () => {
  it("is a labelled slider that reads its value and what the track shows", () => {
    render(<Memory />);
    expect(slider().getAttribute("aria-valuetext")).toBe("4 GB");
    expect(slider().value).toBe("4");
    const described = slider().getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toBe("1 GB in use");
    expect(screen.getByRole("button", { name: "Memory limit: 7.6 GB" })).toBeTruthy();
  });

  it("steps with the arrows and pages with Page Up and Page Down", () => {
    const changed = vi.fn();
    render(<Memory onValueChange={changed} />);
    press("ArrowRight");
    press("ArrowUp");
    expect(slider().getAttribute("aria-valuetext")).toBe("5 GB");
    press("ArrowLeft");
    press("ArrowDown");
    press("ArrowDown");
    expect(slider().getAttribute("aria-valuetext")).toBe("3.5 GB");
    press("PageUp");
    expect(slider().getAttribute("aria-valuetext")).toBe("4.5 GB");
    press("PageDown");
    press("PageDown");
    expect(slider().getAttribute("aria-valuetext")).toBe("2.5 GB");
    expect(changed.mock.calls.map(([gb]) => gb)).toEqual([4.5, 5, 4.5, 4, 3.5, 4.5, 3.5, 2.5]);
  });

  it("goes to the ends with Home and End, and never past what may be chosen", () => {
    render(<Memory />);
    press("End");
    expect(slider().getAttribute("aria-valuetext")).toBe("5.5 GB");
    press("PageUp");
    press("ArrowRight");
    expect(slider().getAttribute("aria-valuetext")).toBe("5.5 GB");
    press("Home");
    expect(slider().getAttribute("aria-valuetext")).toBe("2 GB");
    press("ArrowLeft");
    expect(slider().getAttribute("aria-valuetext")).toBe("2 GB");
  });

  it("says why it stops when a key or a drag tries to go past an end, until it moves back", () => {
    const spoken = vi.spyOn(Announcer, "announce").mockImplementation(() => {});
    render(<Memory />);
    const status = () => document.querySelector(".ui-step-slider-reason")?.textContent;
    press("End");
    expect(status()).toBe("");
    press("ArrowRight");
    expect(status()).toBe("Other dots and Docker itself hold the rest.");
    expect(slider().getAttribute("aria-describedby")).toContain(
      document.querySelector(".ui-step-slider-reason")?.id,
    );
    press("ArrowLeft");
    expect(status()).toBe("");
    press("End");
    press("End");
    expect(status()).toBe("Other dots and Docker itself hold the rest.");
    fireEvent.change(slider(), { target: { value: "0.5" } });
    expect(slider().getAttribute("aria-valuetext")).toBe("2 GB");
    expect(status()).toBe("dot's computer needs at least 2 GB.");
    fireEvent.change(slider(), { target: { value: "7.5" } });
    expect(slider().getAttribute("aria-valuetext")).toBe("5.5 GB");
    expect(slider().value).toBe("5.5");
    expect(spoken.mock.calls.map(([, text]) => text)).toEqual([
      "Other dots and Docker itself hold the rest.",
      "Other dots and Docker itself hold the rest.",
      "dot's computer needs at least 2 GB.",
      "Other dots and Docker itself hold the rest.",
    ]);
  });

  it("takes a press on the track as the value there, on a whole step", () => {
    render(<Memory />);
    fireEvent.change(slider(), { target: { value: "3" } });
    expect(slider().getAttribute("aria-valuetext")).toBe("3 GB");
  });

  it("leaves keys with a modifier, and others, to the page", () => {
    const changed = vi.fn();
    render(<Memory onValueChange={changed} />);
    expect(fireEvent.keyDown(slider(), { key: "ArrowRight", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(slider(), { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(slider(), { key: "ArrowRight" })).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("lets a value above what may be chosen now be kept or lowered, not raised", () => {
    render(<Memory value={6} />);
    expect(slider().getAttribute("aria-valuetext")).toBe("6 GB");
    press("ArrowLeft");
    expect(slider().getAttribute("aria-valuetext")).toBe("5.5 GB");
    press("ArrowRight");
    expect(slider().getAttribute("aria-valuetext")).toBe("5.5 GB");
  });
});
