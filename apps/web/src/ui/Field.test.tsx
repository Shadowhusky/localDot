// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field } from "./Field.tsx";
import { MoneyField, moneyInput } from "./MoneyField.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { TextArea } from "./TextArea.tsx";
import { TextField } from "./TextField.tsx";

afterEach(cleanup);

function described(element: HTMLElement): string[] {
  const ids = element.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? `missing ${id}`);
}

describe("Field", () => {
  it("names its control and describes it", () => {
    render(
      <Field label="Task budget" description="Up to $100 a task">
        <TextField />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Task budget" });
    expect(described(input)).toEqual(["Up to $100 a task"]);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("puts an error first and keeps the description in the same place", () => {
    const { container } = render(
      <Field
        label="Model ID"
        description="As your provider spells it"
        error="Use letters and digits"
      >
        <TextField />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Model ID" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(described(input)).toEqual(["Use letters and digits", "As your provider spells it"]);
    const message = container.querySelector(".ui-field-message");
    expect(message?.children).toHaveLength(2);
    expect(container.querySelector(".ui-field-description")?.hasAttribute("data-inactive")).toBe(
      true,
    );
    expect(container.querySelector(".ui-field-error svg")).not.toBeNull();
  });

  it("keeps a line for an error yet to come, with or without a description", () => {
    const { container, rerender } = render(
      <Field label="Key name" error={undefined}>
        <TextField />
      </Field>,
    );
    const message = container.querySelector(".ui-field-message");
    expect(message).not.toBeNull();
    expect(message?.children).toHaveLength(0);
    rerender(
      <Field label="Key name" error="Give the key a name">
        <TextField />
      </Field>,
    );
    expect(container.querySelector(".ui-field-message")).toBe(message);
    expect(message?.textContent).toBe("Give the key a name");
    rerender(
      <Field label="Search keys">
        <TextField />
      </Field>,
    );
    expect(container.querySelector(".ui-field-message")).toBeNull();
    rerender(
      <Field label="Search keys" validates>
        <TextField />
      </Field>,
    );
    expect(container.querySelector(".ui-field-message")).not.toBeNull();
  });

  it("keeps an unavailable field focusable, read-only and says why", () => {
    const onChange = vi.fn();
    render(
      <Field label="Main model" disabledReason="Choose a provider first">
        <TextField value="" onChange={onChange} />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Main model" });
    expect(input.hasAttribute("disabled")).toBe(false);
    expect(input.getAttribute("aria-disabled")).toBe("true");
    expect((input as HTMLInputElement).readOnly).toBe(true);
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(described(input)).toEqual(["Choose a provider first"]);
  });

  it("focuses the chosen segment when a group's label is clicked", () => {
    render(
      <Field label="Speed">
        <SegmentedControl
          value="1"
          onValueChange={() => {}}
          items={[
            { value: "0.5", label: "0.5×" },
            { value: "1", label: "1×" },
          ]}
        />
      </Field>,
    );
    fireEvent.click(screen.getByText("Speed"));
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "1×" }));
  });
});

describe("TextField", () => {
  it("draws its affixes inside the edge and sends a press on them to the input", () => {
    const { container } = render(<TextField aria-label="Search" prefix="$" suffix="USD" />);
    const input = screen.getByRole("textbox", { name: "Search" });
    const box = container.querySelector(".ui-text-field") as HTMLElement;
    expect(box.contains(input)).toBe(true);
    fireEvent.pointerDown(screen.getByText("$"));
    expect(document.activeElement).toBe(input);
  });
});

describe("MoneyField", () => {
  it("keeps only an amount: digits, one point and two decimals", () => {
    expect(moneyInput("12.345")).toBe("12.34");
    expect(moneyInput("$1,000.5")).toBe("1000.5");
    expect(moneyInput("1.2.3")).toBe("1.23");
    expect(moneyInput("abc")).toBe("");
    expect(moneyInput(".")).toBe(".");
  });

  it("asks a phone for its decimal pad and reports the cleaned amount", () => {
    function Budget() {
      const [value, setValue] = useState("");
      return <MoneyField aria-label="Budget" value={value} onValueChange={setValue} />;
    }
    render(<Budget />);
    const input = screen.getByRole("textbox", { name: "Budget" }) as HTMLInputElement;
    expect(input.inputMode).toBe("decimal");
    fireEvent.change(input, { target: { value: "3.999x" } });
    expect(input.value).toBe("3.99");
  });
});

describe("TextArea", () => {
  it("starts at one line and caps its growth at the rows given", () => {
    render(<TextArea aria-label="Message" maxRows={6} />);
    const area = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(area.rows).toBe(1);
    expect(area.style.getPropertyValue("--_rows")).toBe("6");
  });
});
