// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkbox } from "./Checkbox.tsx";
import { Field } from "./Field.tsx";
import { RadioCards } from "./RadioCards.tsx";
import { Switch } from "./Switch.tsx";

afterEach(cleanup);

function describedBy(element: HTMLElement): string | undefined {
  const ids = element.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent).join(" ") || undefined;
}

describe("Checkbox", () => {
  it("toggles from anywhere on its row and reports the new state", () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox
        label="Show narration"
        description="dot says what it does"
        onCheckedChange={onCheckedChange}
      />,
    );
    const box = screen.getByRole("checkbox", { name: "Show narration" });
    expect(describedBy(box)).toBe("dot says what it does");
    fireEvent.click(screen.getByText("dot says what it does"));
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("is mixed while indeterminate", () => {
    render(<Checkbox label="All files" indeterminate checked={false} onCheckedChange={() => {}} />);
    const box = screen.getByRole("checkbox", { name: "All files" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
  });

  it("stays focusable but ignores presses while unavailable, and says why", () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox
        label="Use the fast model"
        description="For quick steps"
        disabledReason="Choose a fast model first"
        onCheckedChange={onCheckedChange}
      />,
    );
    const box = screen.getByRole("checkbox", { name: "Use the fast model" }) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.getAttribute("aria-disabled")).toBe("true");
    box.focus();
    expect(document.activeElement).toBe(box);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(describedBy(box)).toBe("Choose a fast model first");
  });
});

describe("Switch", () => {
  it("is a switch with its label at the start of the row", () => {
    function Narration() {
      const [on, setOn] = useState(false);
      return <Switch label="Show dot" checked={on} onCheckedChange={setOn} />;
    }
    const { container } = render(<Narration />);
    const toggle = screen.getByRole("switch", { name: "Show dot" }) as HTMLInputElement;
    const row = container.querySelector(".ui-choice") as HTMLElement;
    expect(row.firstElementChild?.textContent).toBe("Show dot");
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
  });

  it("marks its row pressed on pointer-down so the knob can stretch", () => {
    const { container } = render(<Switch label="Show dot" />);
    const row = container.querySelector(".ui-choice") as HTMLElement;
    fireEvent.pointerDown(row, { button: 0, pointerType: "touch" });
    expect(row.dataset.pressed).toBeDefined();
    fireEvent.pointerUp(row, { button: 0, pointerType: "touch" });
    expect(row.dataset.pressed).toBeUndefined();
  });
});

describe("RadioCards", () => {
  const THEMES = [
    { value: "graphite", label: "Graphite", preview: <span>tile</span> },
    { value: "midnight", label: "Midnight" },
    { value: "daylight", label: "Daylight", disabledReason: "Coming later" },
  ];

  it("is a radio group named by its Field, one card per choice", () => {
    const onValueChange = vi.fn();
    render(
      <Field label="Theme">
        <RadioCards value="graphite" onValueChange={onValueChange} options={THEMES} />
      </Field>,
    );
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(group.querySelectorAll("input[type=radio]")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Graphite" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByText("Midnight"));
    expect(onValueChange).toHaveBeenCalledWith("midnight");
  });

  it("draws a preview inside the card, not a second control beside it", () => {
    const { container } = render(
      <RadioCards aria-label="Theme" value="graphite" onValueChange={() => {}} options={THEMES} />,
    );
    const card = screen.getByRole("radio", { name: "Graphite" }).closest("label");
    expect(card?.querySelector(".ui-radio-card-preview")?.textContent).toBe("tile");
    expect(container.querySelectorAll("input")).toHaveLength(3);
  });

  it("keeps an unavailable choice readable and unchosen", () => {
    const onValueChange = vi.fn();
    render(
      <RadioCards
        aria-label="Theme"
        value="graphite"
        onValueChange={onValueChange}
        options={THEMES}
      />,
    );
    const daylight = screen.getByRole("radio", { name: "Daylight" });
    expect(daylight.getAttribute("aria-disabled")).toBe("true");
    expect(describedBy(daylight)).toBe("Coming later");
    fireEvent.click(daylight);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
