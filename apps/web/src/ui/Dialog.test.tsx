// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog.tsx";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [deleted, setDeleted] = useState(0);
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Delete recording
      </button>
      <p>Deleted {deleted}</p>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        title="Delete this recording?"
        description="You can't undo this."
      >
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            setDeleted((count) => count + 1);
            setOpen(false);
          }}
        >
          Delete
        </button>
      </Dialog>
    </>
  );
}

function open(): HTMLElement {
  const trigger = screen.getByRole("button", { name: "Delete recording" });
  trigger.focus();
  fireEvent.click(trigger);
  return screen.getByRole("alertdialog", { name: "Delete this recording?" });
}

describe("Dialog", () => {
  it("is a described alert whose safe choice has focus", () => {
    render(<Harness />);
    const dialog = open();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("You can't undo this.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("closes on Escape without acting and gives focus back to the control that asked", () => {
    render(<Harness />);
    open();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.getByText("Deleted 0")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete recording" }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("keeps Tab between its choices", () => {
    render(<Harness />);
    open();
    const remove = screen.getByRole("button", { name: "Delete" });
    remove.focus();
    fireEvent.keyDown(remove, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });
});
