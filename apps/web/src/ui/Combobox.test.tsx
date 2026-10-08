// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Combobox } from "./Combobox.tsx";
import { Field } from "./Field.tsx";

afterEach(cleanup);

const MODELS = [
  { value: "claude-opus-4-1", label: "Claude Opus 4.1" },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", keywords: "balanced" },
  { value: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { value: "legacy-model", label: "Legacy model", disabledReason: "Retired by the provider" },
];

function Model({ onChange = () => {} }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("claude-opus-4-1");
  return (
    <Field label="Main model" description="Plans and acts">
      <Combobox
        value={value}
        items={MODELS}
        customDescription="Custom model ID"
        onValueChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </Field>
  );
}

function trigger(): HTMLElement {
  return screen.getByRole("combobox", { name: "Main model" });
}

function search(): HTMLInputElement {
  return screen.getByRole("combobox", { name: "Search: Main model" }) as HTMLInputElement;
}

function rows(): string[] {
  return screen.getAllByRole("option").map((row) => row.textContent ?? "");
}

describe("Combobox", () => {
  it("opens a dialog with its search field focused, not tied to the Field", () => {
    render(<Model />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    screen.getByRole("dialog", { name: "Main model" });
    expect(document.activeElement).toBe(search());
    expect(search().id).not.toBe(trigger().id);
    expect(search().getAttribute("aria-describedby")).toBeNull();
    expect(search().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  });

  it("filters as you type, marks what matched, and Enter takes the first match", () => {
    const onChange = vi.fn();
    render(<Model onChange={onChange} />);
    fireEvent.keyDown(trigger(), { key: "Enter" });
    fireEvent.change(search(), { target: { value: "son" } });
    expect(rows()).toEqual(["Claude Sonnet 4.5", "Claude Sonnet 4", "Use “son”Custom model ID"]);
    const first = screen.getAllByRole("option")[0] as HTMLElement;
    expect(first.querySelector("mark")?.textContent).toBe("Son");
    expect(search().getAttribute("aria-activedescendant")).toBe(first.id);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("claude-sonnet-4-5");
    expect(trigger().textContent).toBe("Claude Sonnet 4.5");
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves Enter and Escape to an input method while it composes a search", () => {
    const onChange = vi.fn();
    const sheetSaw = vi.fn();
    const escapes = (event: KeyboardEvent) => {
      if (event.key === "Escape") sheetSaw();
    };
    render(<Model onChange={onChange} />);
    fireEvent.keyDown(trigger(), { key: "Enter" });
    fireEvent.change(search(), { target: { value: "son" } });
    window.addEventListener("keydown", escapes);
    fireEvent.keyDown(search(), { key: "Enter", keyCode: 229, isComposing: true });
    fireEvent.keyDown(search(), { key: "Escape", keyCode: 229, isComposing: true });
    window.removeEventListener("keydown", escapes);
    expect(onChange).not.toHaveBeenCalled();
    expect(sheetSaw).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(search());
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("claude-sonnet-4-5");
  });

  it("matches keywords as well as labels", () => {
    render(<Model />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.change(search(), { target: { value: "balanced" } });
    expect(rows()[0]).toBe("Claude Sonnet 4.5");
  });

  it("offers what was typed as a custom ID, pinned last", () => {
    const onChange = vi.fn();
    render(<Model onChange={onChange} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.change(search(), { target: { value: "my-finetune-7b" } });
    expect(rows()).toEqual(["Use “my-finetune-7b”Custom model ID"]);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("my-finetune-7b");
    expect(trigger().textContent).toBe("my-finetune-7b");
  });

  it("says when nothing matches and there is no custom value to offer", () => {
    render(<Combobox aria-label="Main model" value="" onValueChange={() => {}} items={MODELS} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Main model" }), { key: "ArrowDown" });
    fireEvent.change(screen.getByRole("combobox", { name: "Search: Main model" }), {
      target: { value: "zzz" },
    });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("starts the search with a letter typed on the closed trigger", () => {
    render(<Model />);
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "h" });
    expect(search().value).toBe("h");
    expect(within(screen.getByRole("listbox")).getAllByRole("option")[0]?.textContent).toBe(
      "Claude Haiku 4.5",
    );
  });

  it("closes on Tab and hands focus back to its trigger", () => {
    render(<Model />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Tab" });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });
});
