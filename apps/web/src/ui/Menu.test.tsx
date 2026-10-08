// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuGroup, MenuItem, MenuSeparator } from "./Menu.tsx";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function Harness() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("none");
  const [under, setUnder] = useState(0);
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Recording actions
      </button>
      <button type="button" onClick={() => setUnder((count) => count + 1)}>
        Under {under}
      </button>
      <p>Chose {choice}</p>
      <Menu open={open} onClose={() => setOpen(false)} anchor={trigger} label="Recording actions">
        <MenuItem onSelect={() => setChoice("rename")}>Rename</MenuItem>
        <MenuItem kbd={["Mod", "D"]} onSelect={() => setChoice("duplicate")}>
          Duplicate
        </MenuItem>
        <MenuItem onSelect={() => setChoice("download")}>Download</MenuItem>
        <MenuSeparator />
        <MenuGroup label="On this Mac">
          <MenuItem onSelect={() => setChoice("show")}>Show files</MenuItem>
          <MenuItem disabledReason="Stop the task first" onSelect={() => setChoice("delete")}>
            Delete recording
          </MenuItem>
        </MenuGroup>
      </Menu>
    </>
  );
}

function openWithKeyboard(): HTMLElement {
  const trigger = screen.getByRole("button", { name: "Recording actions" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(trigger);
  return screen.getByRole("menu", { name: "Recording actions" });
}

function focused(): string | null | undefined {
  return document.activeElement?.getAttribute("data-label");
}

function key(menu: HTMLElement, name: string) {
  fireEvent.keyDown(document.activeElement ?? menu, { key: name });
}

describe("Menu", () => {
  it("opened from the keyboard lands on the first item and moves with arrows, Home and End", () => {
    render(<Harness />);
    const menu = openWithKeyboard();
    expect(focused()).toBe("Rename");
    key(menu, "ArrowDown");
    expect(focused()).toBe("Duplicate");
    key(menu, "End");
    expect(focused()).toBe("Delete recording");
    key(menu, "ArrowDown");
    expect(focused()).toBe("Rename");
    key(menu, "ArrowUp");
    expect(focused()).toBe("Delete recording");
    key(menu, "Home");
    expect(focused()).toBe("Rename");
  });

  it("opened by a press waits for the pointer or an arrow key", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Recording actions" });
    fireEvent.pointerDown(trigger);
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(document.activeElement).toBe(menu);
    key(menu, "ArrowDown");
    expect(focused()).toBe("Rename");
  });

  it("jumps to an item by its first letters, and on to the next with the same letter", () => {
    render(<Harness />);
    const menu = openWithKeyboard();
    key(menu, "d");
    expect(focused()).toBe("Duplicate");
    key(menu, "d");
    expect(focused()).toBe("Download");
    wait(600);
    key(menu, "s");
    key(menu, "h");
    expect(focused()).toBe("Show files");
  });

  it("runs the chosen item, closes and puts focus back on its button", () => {
    render(<Harness />);
    const menu = openWithKeyboard();
    key(menu, "ArrowDown");
    fireEvent.click(document.activeElement as HTMLElement);
    expect(screen.getByText("Chose duplicate")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Recording actions" }));
    wait(300);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps an unavailable item reachable, says why, and does not run it", () => {
    render(<Harness />);
    openWithKeyboard();
    const item = screen.getByRole("menuitem", { name: "Delete recording" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item).toHaveProperty("disabled", false);
    expect(document.getElementById(item.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Stop the task first",
    );
    fireEvent.click(item);
    expect(screen.getByText("Chose none")).toBeTruthy();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on Escape or Tab and gives focus back", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Recording actions" });
    let menu = openWithKeyboard();
    key(menu, "Escape");
    expect(document.activeElement).toBe(trigger);
    wait(300);
    menu = openWithKeyboard();
    key(menu, "Tab");
    expect(document.activeElement).toBe(trigger);
    wait(300);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays on the page while the press that closed it is still down, so its release lands nowhere", () => {
    render(<Harness />);
    const menu = openWithKeyboard();
    const layer = menu.closest(".ui-layer");
    const catcher = layer?.querySelector(".ui-catcher");
    if (!layer || !catcher) throw new Error("no catcher");
    fireEvent.pointerDown(catcher, { pointerId: 7 });
    expect(layer.hasAttribute("data-closing")).toBe(true);
    wait(600);
    expect(layer.isConnected).toBe(true);
    fireEvent.pointerUp(document, { pointerId: 7 });
    wait(100);
    expect(layer.isConnected).toBe(false);
  });

  it("lets go of a press held too long", () => {
    render(<Harness />);
    const menu = openWithKeyboard();
    const layer = menu.closest(".ui-layer");
    const catcher = layer?.querySelector(".ui-catcher");
    if (!layer || !catcher) throw new Error("no catcher");
    fireEvent.pointerDown(catcher, { pointerId: 7 });
    wait(900);
    expect(layer.isConnected).toBe(true);
    wait(400);
    expect(layer.isConnected).toBe(false);
    fireEvent.pointerUp(document, { pointerId: 7 });
  });

  it("a press outside only closes it: the control beneath never gets it", () => {
    render(<Harness />);
    const menu = openWithKeyboard();
    const catcher = menu.parentElement?.querySelector(".ui-catcher");
    if (!catcher) throw new Error("no catcher");
    expect(fireEvent.pointerDown(catcher)).toBe(false);
    fireEvent.pointerUp(catcher);
    fireEvent.click(catcher);
    expect(screen.getByText("Under 0")).toBeTruthy();
    wait(300);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
