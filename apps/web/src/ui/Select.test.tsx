// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field } from "./Field.tsx";
import type { PickerGroup } from "./listbox.ts";
import { Select } from "./Select.tsx";

afterEach(cleanup);

const AUTONOMY = [
  { value: "ask", label: "Ask before each step" },
  { value: "risky", label: "Ask before risky steps", description: "Sends, uploads and installs" },
  { value: "never", label: "Never ask", disabledReason: "Turned off by your administrator" },
  { value: "watch", label: "Watch only" },
];

const PROVIDERS: PickerGroup[] = [
  {
    label: "Hosted",
    items: [
      { value: "anthropic", label: "Anthropic" },
      { value: "deepseek", label: "DeepSeek" },
    ],
  },
  { label: "On this Mac", items: [{ value: "ollama", label: "Ollama" }] },
];

function Autonomy({ onChange = () => {} }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("risky");
  return (
    <Field label="Autonomy">
      <Select
        value={value}
        items={AUTONOMY}
        onValueChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </Field>
  );
}

function trigger(): HTMLElement {
  return screen.getByRole("combobox", { name: "Autonomy" });
}

function active(): string | null | undefined {
  const id = trigger().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.querySelector(".ui-option-label")?.textContent : null;
}

describe("Select", () => {
  it("opens on the chosen row with the arrow keys and keeps focus on its trigger", () => {
    render(<Autonomy />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox", { name: "Autonomy" });
    expect(trigger().getAttribute("aria-controls")).toBe(list.id);
    expect(active()).toBe("Ask before risky steps");
    expect(document.activeElement).toBe(trigger());
    const chosen = within(list).getByRole("option", { selected: true });
    expect(chosen.textContent).toContain("Ask before risky steps");
  });

  it("moves with the keys, chooses with Enter and closes", () => {
    const onChange = vi.fn();
    render(<Autonomy onChange={onChange} />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    fireEvent.keyDown(trigger(), { key: "End" });
    expect(active()).toBe("Watch only");
    fireEvent.keyDown(trigger(), { key: "Home" });
    expect(active()).toBe("Ask before each step");
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(active()).toBe("Never ask");
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("watch");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().textContent).toBe("Watch only");
    expect(document.activeElement).toBe(trigger());
  });

  it("shows why a row is unavailable inside the row", () => {
    render(<Autonomy />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const never = screen.getByRole("option", { name: /Never ask/ });
    expect(never.getAttribute("aria-disabled")).toBe("true");
    expect(never.textContent).toContain("Turned off by your administrator");
    fireEvent.click(never);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on Escape without letting the sheet around it see the key", () => {
    const pageSaw = vi.fn();
    const parentSaw = vi.fn();
    const escapes = (event: KeyboardEvent) => {
      if (event.key === "Escape") pageSaw();
    };
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for a sheet that closes on Escape
      <div onKeyDown={(event) => event.key === "Escape" && parentSaw()}>
        <Autonomy />
      </div>,
    );
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    window.addEventListener("keydown", escapes);
    fireEvent.keyDown(trigger(), { key: "Escape" });
    window.removeEventListener("keydown", escapes);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(pageSaw).not.toHaveBeenCalled();
    expect(parentSaw).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it("jumps by typing, open or closed", () => {
    render(<Autonomy />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "w" });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(active()).toBe("Watch only");
  });

  it("opens on a mouse press and chooses on release over a row", () => {
    const onChange = vi.fn();
    render(<Autonomy onChange={onChange} />);
    fireEvent.pointerDown(trigger(), { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger(), { detail: 1 });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const ask = screen.getByRole("option", { name: "Ask before each step" });
    fireEvent.pointerDown(ask, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(ask, { button: 0, pointerType: "mouse" });
    expect(onChange).toHaveBeenCalledWith("ask");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps focus through a mouse press in the list, and leaves a touch free to scroll it", () => {
    render(<Autonomy />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const row = screen.getByRole("option", { name: "Watch only" });
    expect(fireEvent.pointerDown(row, { button: 0, pointerType: "mouse" })).toBe(false);
    expect(fireEvent.pointerDown(row, { button: 0, pointerType: "touch" })).toBe(true);
  });

  it("opens on a tap's click, not on the touch itself", () => {
    render(<Autonomy />);
    fireEvent.pointerDown(trigger(), { button: 0, pointerType: "touch" });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger(), { detail: 1 });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on a press outside and keeps that press from the page beneath", () => {
    const pageSaw = vi.fn();
    render(
      <>
        <Autonomy />
        <button type="button" onPointerDown={pageSaw}>
          Elsewhere
        </button>
      </>,
    );
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }), { button: 0 });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(pageSaw).not.toHaveBeenCalled();
  });

  it("takes focus from its label without opening", () => {
    render(<Autonomy />);
    fireEvent.click(screen.getByText("Autonomy"));
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("names each group of rows", () => {
    render(<Select aria-label="Provider" value="" onValueChange={() => {}} groups={PROVIDERS} />);
    const select = screen.getByRole("combobox", { name: "Provider" });
    expect(select.textContent).toBe("Choose…");
    fireEvent.keyDown(select, { key: "ArrowDown" });
    const local = screen.getByRole("group", { name: "On this Mac" });
    expect(within(local).getByRole("option", { name: "Ollama" })).toBeTruthy();
  });

  it("leaves the page once its closing motion ends", () => {
    vi.useFakeTimers();
    try {
      render(<Autonomy />);
      fireEvent.keyDown(trigger(), { key: "ArrowDown" });
      fireEvent.keyDown(trigger(), { key: "Escape" });
      expect(screen.getByRole("listbox", { hidden: true })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByRole("listbox", { hidden: true })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
