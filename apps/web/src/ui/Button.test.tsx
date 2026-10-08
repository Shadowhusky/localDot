// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button.tsx";

afterEach(cleanup);

function describedBy(element: HTMLElement): string | undefined {
  const ids = element.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent).join(" ") || undefined;
}

describe("Button", () => {
  it("never submits a form unless asked to", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("type")).toBe("button");
  });

  it("names its variant and size for the stylesheet, secondary and medium by default", () => {
    render(
      <>
        <Button>Cancel</Button>
        <Button variant="primary" size="lg">
          Start task
        </Button>
      </>,
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect([cancel.dataset.variant, cancel.dataset.size]).toEqual(["secondary", "md"]);
    const start = screen.getByRole("button", { name: "Start task" });
    expect([start.dataset.variant, start.dataset.size]).toEqual(["primary", "lg"]);
  });

  it("stays focusable while unavailable and says why", () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabledReason="Choose a main provider and model">
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(describedBy(button)).toBe("Choose a main provider and model");
  });

  it("keeps its own description beside the reason", () => {
    render(
      <>
        <p id="hint">Saves for every task</p>
        <Button aria-describedby="hint" disabledReason="Nothing changed yet">
          Save
        </Button>
      </>,
    );
    expect(describedBy(screen.getByRole("button", { name: "Save" }))).toBe(
      "Saves for every task Nothing changed yet",
    );
  });

  it("does not submit its form while unavailable", () => {
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
        <Button type="submit" disabledReason="Add a key first">
          Save
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("holds its label in place while busy, so it keeps its width", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    rerender(
      <Button onClick={onClick} busy>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.querySelector(".ui-button-content")?.textContent).toBe("Save");
    expect(button.querySelector(".ui-spinner")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows the press on pointer-down and lets go on release", () => {
    render(<Button>Pause</Button>);
    const button = screen.getByRole("button", { name: "Pause" });
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    expect(button.dataset.pressed).toBe("squeeze");
    fireEvent.pointerUp(button, { button: 0, pointerType: "mouse" });
    expect(button.dataset.pressed).toBeUndefined();
  });

  it("only darkens a control too wide to squeeze", () => {
    render(<Button>Turn on your computer while you choose a model</Button>);
    const button = screen.getByRole("button");
    button.getBoundingClientRect = () => DOMRect.fromRect({ width: 320, height: 32 });
    fireEvent.pointerDown(button, { button: 0, pointerType: "touch" });
    expect(button.dataset.pressed).toBe("fill");
    fireEvent.pointerCancel(button, { pointerType: "touch" });
    expect(button.dataset.pressed).toBeUndefined();
  });

  it("lets a press go when the pointer slides off, and takes it back when it returns", () => {
    render(<Button>Stop</Button>);
    const button = screen.getByRole("button", { name: "Stop" });
    fireEvent.pointerDown(button, { button: 0, buttons: 1, pointerType: "mouse" });
    fireEvent.pointerLeave(button, { buttons: 1, pointerType: "mouse" });
    expect(button.dataset.pressed).toBeUndefined();
    fireEvent.pointerEnter(button, { buttons: 1, pointerType: "mouse" });
    expect(button.dataset.pressed).toBe("squeeze");
  });

  it("presses with the space bar", () => {
    render(<Button>Continue</Button>);
    const button = screen.getByRole("button", { name: "Continue" });
    fireEvent.keyDown(button, { key: " " });
    expect(button.dataset.pressed).toBe("squeeze");
    fireEvent.keyUp(button, { key: " " });
    expect(button.dataset.pressed).toBeUndefined();
  });

  it("shows no press while unavailable or for a secondary mouse button", () => {
    render(
      <>
        <Button disabledReason="Turn on your computer first">Start task</Button>
        <Button>Copy</Button>
      </>,
    );
    const start = screen.getByRole("button", { name: "Start task" });
    fireEvent.pointerDown(start, { button: 0, pointerType: "mouse" });
    expect(start.dataset.pressed).toBeUndefined();
    const copy = screen.getByRole("button", { name: "Copy" });
    fireEvent.pointerDown(copy, { button: 2, pointerType: "mouse" });
    expect(copy.dataset.pressed).toBeUndefined();
  });

  it("still runs the caller's own handlers", () => {
    const onPointerDown = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <Button onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
        Send
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    fireEvent.keyDown(button, { key: "Enter" });
    expect(onPointerDown).toHaveBeenCalledOnce();
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(button.dataset.pressed).toBe("squeeze");
  });

  it("draws a leading icon hidden from assistive technology", () => {
    render(<Button icon="download">Download</Button>);
    const button = screen.getByRole("button", { name: "Download" });
    expect(button.dataset.icon).toBe("");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
