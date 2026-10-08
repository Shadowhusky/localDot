// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuItem } from "./Menu.tsx";
import { Sheet } from "./Sheet.tsx";
import { Tooltip } from "./Tooltip.tsx";

const SAVED = "Research assistant";

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

function Harness({ modal = true }: { modal?: boolean }) {
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [name, setName] = useState(SAVED);
  const [closed, setClosed] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      <p>Closed {closed}</p>
      <Sheet
        open={open}
        modal={modal}
        dirty={name !== SAVED}
        title="Models and settings"
        closeLabel="Close settings"
        onClose={() => {
          setOpen(false);
          setName(SAVED);
          setClosed((count) => count + 1);
        }}
        footer={<button type="button">Save</button>}
      >
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Provider
          <select>
            <option>Anthropic</option>
            <option>OpenAI</option>
          </select>
        </label>
        <button ref={more} type="button" onClick={() => setMenu(true)}>
          Model actions
        </button>
        <Menu open={menu} onClose={() => setMenu(false)} anchor={more} label="Model actions">
          <MenuItem onSelect={() => {}}>Copy model name</MenuItem>
        </Menu>
        <Tooltip content="Explains the spending limits">
          <button type="button">Limits</button>
        </Tooltip>
      </Sheet>
    </>
  );
}

function open() {
  const trigger = screen.getByRole("button", { name: "Open settings" });
  trigger.focus();
  fireEvent.click(trigger);
  return screen.getByRole("dialog", { name: "Models and settings" });
}

function pressEscape(target: Element = document.activeElement ?? document.body) {
  fireEvent.keyDown(target, { key: "Escape" });
}

function prompt(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ui-sheet-prompt[data-shown]");
}

function closedCount(): string | null | undefined {
  return screen.getByText(/^Closed/).textContent;
}

describe("Sheet", () => {
  it("opens as a labelled modal, focuses the first field and gives focus back when it closes", () => {
    render(<Harness />);
    const sheet = open();
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    pressEscape();
    expect(closedCount()).toBe("Closed 1");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open settings" }));
    wait(400);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before discarding unsaved changes, whichever way it is dismissed", () => {
    render(<Harness />);
    const sheet = open();
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Research assistant, faster" } });

    pressEscape();
    expect(prompt()).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
    pressEscape();
    expect(prompt()).toBeNull();
    expect(document.activeElement).toBe(name);

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(prompt()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(prompt()).toBeNull();

    const scrim = sheet.parentElement?.querySelector(".ui-scrim");
    if (!scrim) throw new Error("no scrim");
    fireEvent.pointerDown(scrim, { button: 0 });
    fireEvent.pointerUp(scrim, { button: 0 });
    fireEvent.click(scrim);
    expect(prompt()).not.toBeNull();
    expect(closedCount()).toBe("Closed 0");
    expect(name).toHaveProperty("value", "Research assistant, faster");

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(closedCount()).toBe("Closed 1");
  });

  it("leaves Escape to a native select inside it", () => {
    render(<Harness />);
    open();
    const select = screen.getByLabelText("Provider");
    select.focus();
    pressEscape(select);
    expect(screen.getByRole("dialog", { name: "Models and settings" })).toBeTruthy();
    expect(closedCount()).toBe("Closed 0");
    expect(prompt()).toBeNull();
  });

  it("closes from the dim area only when the press starts and ends there", () => {
    render(<Harness />);
    const sheet = open();
    const layer = sheet.parentElement as HTMLElement;
    const scrim = layer.querySelector(".ui-scrim") as HTMLElement;
    // Pressed on the panel and released on the dim area: the click lands on what both share.
    fireEvent.pointerDown(sheet, { button: 0 });
    fireEvent.pointerUp(scrim, { button: 0 });
    fireEvent.click(layer);
    // Pressed on the dim area and released on the panel.
    fireEvent.pointerDown(scrim, { button: 0 });
    fireEvent.pointerUp(sheet, { button: 0 });
    fireEvent.click(layer);
    expect(closedCount()).toBe("Closed 0");
    fireEvent.pointerDown(scrim, { button: 0 });
    fireEvent.pointerUp(scrim, { button: 0 });
    fireEvent.click(scrim);
    expect(closedCount()).toBe("Closed 1");
  });

  it("lets Escape close a menu inside it and nothing else", () => {
    render(<Harness />);
    open();
    const more = screen.getByRole("button", { name: "Model actions" });
    more.focus();
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "Model actions" });
    pressEscape(menu);
    expect(menu.closest(".ui-layer")?.hasAttribute("data-closing")).toBe(true);
    expect(document.activeElement).toBe(more);
    expect(screen.getByRole("dialog", { name: "Models and settings" })).toBeTruthy();
    expect(closedCount()).toBe("Closed 0");
  });

  it("lets Escape close a tooltip shown over it and nothing else", () => {
    render(<Harness />);
    open();
    const name = screen.getByLabelText("Name");
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Limits" }), {
      pointerType: "mouse",
    });
    wait(500);
    expect(document.querySelector(".ui-tooltip:not([data-closing])")).not.toBeNull();
    pressEscape(name);
    expect(document.querySelector(".ui-tooltip:not([data-closing])")).toBeNull();
    expect(closedCount()).toBe("Closed 0");
    pressEscape(name);
    expect(closedCount()).toBe("Closed 1");
  });

  it("keeps focus inside while modal", () => {
    render(<Harness />);
    open();
    const close = screen.getByRole("button", { name: "Close settings" });
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
    fireEvent.keyUp(save, { key: "Tab", shiftKey: true });
    screen.getByRole("button", { name: "Open settings" }).focus();
    expect(document.activeElement).toBe(close);
  });

  it("locks the page's scroll while modal and lets it go once closed", () => {
    render(<Harness />);
    open();
    expect(document.documentElement.style.overflow).toBe("hidden");
    pressEscape();
    wait(400);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("beside the page, neither dims, locks nor holds focus", () => {
    render(<Harness modal={false} />);
    const sheet = open();
    expect(sheet.getAttribute("aria-modal")).toBe("false");
    expect(document.querySelector(".ui-scrim")).toBeNull();
    expect(document.documentElement.style.overflow).toBe("");
    const outside = screen.getByRole("button", { name: "Open settings" });
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });

  it("beside the page, leaves an Escape pressed in the page to the page", () => {
    render(<Harness modal={false} />);
    open();
    const outside = screen.getByRole("button", { name: "Open settings" });
    outside.focus();
    pressEscape(outside);
    expect(closedCount()).toBe("Closed 0");
    outside.blur();
    pressEscape(document.body);
    expect(closedCount()).toBe("Closed 1");
  });

  it("beside the page, closes on an Escape pressed inside it", () => {
    render(<Harness modal={false} />);
    open();
    pressEscape(screen.getByLabelText("Name"));
    expect(closedCount()).toBe("Closed 1");
  });
});

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Count {count}
    </button>
  );
}

function Pages() {
  const [page, setPage] = useState<"main" | "keys">("main");
  return (
    <Sheet
      open
      onClose={() => {}}
      title={page === "keys" ? "Keys" : "Models and settings"}
      page={page}
      back={page === "keys" ? { label: "Settings", onBack: () => setPage("main") } : undefined}
    >
      {page === "keys" ? (
        <label>
          Key name
          <input />
        </label>
      ) : (
        <>
          <Counter />
          <button type="button" onClick={() => setPage("keys")}>
            Keys
          </button>
        </>
      )}
    </Sheet>
  );
}

function pages() {
  return [...document.querySelectorAll<HTMLElement>(".ui-sheet-page")].map((page) => ({
    page: page.dataset.page,
    leaving: page.hasAttribute("data-leaving"),
    inert: page.hasAttribute("inert"),
    direction: page.dataset.direction,
  }));
}

describe("Sheet pages", () => {
  it("slides a nested page over the first, which keeps its state until it has gone", () => {
    render(<Pages />);
    fireEvent.click(screen.getByRole("button", { name: "Count 0" }));
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByRole("dialog", { name: "Keys" })).toBeTruthy();
    expect(pages()).toEqual([
      { page: "main", leaving: true, inert: true, direction: "forward" },
      { page: "keys", leaving: false, inert: false, direction: "forward" },
    ]);
    expect(document.querySelector("[data-page=main]")?.textContent).toContain("Count 1");
    expect(document.activeElement).toBe(screen.getByLabelText("Key name"));
    wait(400);
    expect(pages()).toEqual([{ page: "keys", leaving: false, inert: false, direction: "forward" }]);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Models and settings" })).toBeTruthy();
    expect(pages()).toEqual([
      { page: "keys", leaving: true, inert: true, direction: "back" },
      { page: "main", leaving: false, inert: false, direction: "back" },
    ]);
  });

  it("goes there and back before the first slide ends without doubling a page", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Pages />);
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(pages()).toEqual([
      { page: "keys", leaving: true, inert: true, direction: "back" },
      { page: "main", leaving: false, inert: false, direction: "back" },
    ]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
