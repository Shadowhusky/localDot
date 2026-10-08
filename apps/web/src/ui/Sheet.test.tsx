// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuItem } from "./Menu.tsx";
import { PHONE } from "./media.ts";
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

  it("stays until its exit transitions have run, however long the tokens make them", async () => {
    let finish = () => {};
    const exit = {
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      effect: { getComputedTiming: () => ({ endTime: 600 }) },
    };
    // The test DOM has no animations to read, so the closing layer reports one that runs long.
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value(this: HTMLElement) {
        return this.matches(".ui-layer[data-closing]") ? [exit] : [];
      },
    });
    try {
      render(<Harness />);
      const sheet = open();
      pressEscape();
      wait(500);
      expect(sheet.isConnected).toBe(true);
      await act(async () => finish());
      expect(sheet.isConnected).toBe(false);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    }
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

// A screen that can change between phone and wide while a sheet is open.
function screenWidth(phone: boolean) {
  let now = phone;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      return query === PHONE && now;
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    now = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
}

function Defaults({ side }: { side?: "auto" | "inspector" | "bottom" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      <Sheet open={open} side={side} title="Models and settings" onClose={() => setOpen(false)}>
        <label>
          Name
          <input />
        </label>
      </Sheet>
    </>
  );
}

describe("Sheet defaults", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("sits beside the page as an inspector, so the page stays live, and is modal as a bottom sheet", () => {
    const { unmount } = render(<Defaults side="inspector" />);
    expect(open().getAttribute("aria-modal")).toBe("false");
    expect(document.querySelector(".ui-scrim")).toBeNull();
    expect(document.documentElement.style.overflow).toBe("");
    unmount();
    render(<Defaults side="bottom" />);
    expect(open().getAttribute("aria-modal")).toBe("true");
    expect(document.querySelector(".ui-scrim")).not.toBeNull();
  });

  it("gives focus back to what opened it after the screen widened it into an inspector", () => {
    const resize = screenWidth(true);
    render(<Defaults />);
    const sheet = open();
    expect(sheet.dataset.side).toBe("bottom");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    resize(false);
    expect(sheet.dataset.side).toBe("inspector");
    expect(sheet.getAttribute("aria-modal")).toBe("false");
    pressEscape(screen.getByLabelText("Name"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open settings" }));
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

const TITLES = { main: "Models and settings", keys: "Keys", key: "Anthropic key" };

function Pages() {
  const [page, setPage] = useState<keyof typeof TITLES>("main");
  const back = {
    main: undefined,
    keys: { label: "Settings", onBack: () => setPage("main") },
    key: { label: "Keys", onBack: () => setPage("keys") },
  }[page];
  return (
    <Sheet open onClose={() => {}} title={TITLES[page]} page={page} back={back}>
      {page === "main" && (
        <>
          <Counter />
          <button type="button" onClick={() => setPage("keys")}>
            Open keys
          </button>
        </>
      )}
      {page === "keys" && (
        <>
          <label>
            Key name
            <input />
          </label>
          <button type="button" onClick={() => setPage("key")}>
            Anthropic
          </button>
        </>
      )}
      {page === "key" && <p>Added 2 Oct</p>}
    </Sheet>
  );
}

function pages() {
  return [...document.querySelectorAll<HTMLElement>(".ui-sheet-page")].map((page) => ({
    page: page.dataset.page,
    held: page.hasAttribute("data-held"),
    leaving: page.hasAttribute("data-leaving"),
    inert: page.hasAttribute("inert"),
    direction: page.dataset.direction,
  }));
}

// The test DOM has no transitions, so a page sliding away reports one that runs until ended here.
function slides(): () => Promise<void> {
  const ends: (() => void)[] = [];
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value(this: HTMLElement) {
      if (!this.matches(".ui-sheet-page[data-leaving]")) return [];
      const finished = new Promise<void>((resolve) => ends.push(resolve));
      return [{ finished, effect: { getComputedTiming: () => ({ endTime: 300 }) } }];
    },
  });
  return () =>
    act(async () => {
      for (const end of ends.splice(0)) end();
    });
}

// Opens a page from a row, the way a keyboard user would: the row has focus as it is pressed.
function go(name: string): HTMLElement {
  const row = screen.getByRole("button", { name });
  row.focus();
  fireEvent.click(row);
  return row;
}

function back(name: string) {
  const button = document.querySelector<HTMLElement>(
    ".ui-sheet-page:not([data-held], [data-leaving]) .ui-sheet-back",
  );
  expect(button?.textContent).toBe(name);
  if (button) fireEvent.click(button);
}

describe("Sheet pages", () => {
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  });

  it("keeps the page it came from under a nested one, so Back finds it as it was", async () => {
    const end = slides();
    render(<Pages />);
    fireEvent.click(screen.getByRole("button", { name: "Count 0" }));
    const row = go("Open keys");
    expect(screen.getByRole("dialog", { name: "Keys" })).toBeTruthy();
    const under = { page: "main", held: true, leaving: false, inert: true, direction: "forward" };
    const keys = { page: "keys", held: false, leaving: false, inert: false, direction: "forward" };
    expect(pages()).toEqual([under, keys]);
    expect(document.activeElement).toBe(screen.getByLabelText("Key name"));
    await end();
    expect(pages()).toEqual([under, keys]);
    expect(document.querySelector("[data-page=main]")?.textContent).toContain("Count 1");

    back("Settings");
    expect(screen.getByRole("dialog", { name: "Models and settings" })).toBeTruthy();
    expect(pages()).toEqual([
      { page: "main", held: false, leaving: false, inert: false, direction: "back" },
      { page: "keys", held: false, leaving: true, inert: true, direction: "back" },
    ]);
    expect(document.activeElement).toBe(row);
    expect(row.isConnected).toBe(true);
    expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
    await end();
    expect(pages()).toEqual([
      { page: "main", held: false, leaving: false, inert: false, direction: "back" },
    ]);
  });

  it("goes two pages deep and back one page at a time, each Back landing on its row", async () => {
    const end = slides();
    render(<Pages />);
    const keysRow = go("Open keys");
    await end();
    const keyRow = go("Anthropic");
    await end();
    expect(pages().map(({ page, held }) => ({ page, held }))).toEqual([
      { page: "main", held: true },
      { page: "keys", held: true },
      { page: "key", held: false },
    ]);

    back("Keys");
    expect(screen.getByRole("dialog", { name: "Keys" })).toBeTruthy();
    expect(pages().find((view) => view.page === "keys")?.direction).toBe("back");
    expect(document.activeElement).toBe(keyRow);
    await end();
    expect(pages().map(({ page, held }) => ({ page, held }))).toEqual([
      { page: "main", held: true },
      { page: "keys", held: false },
    ]);

    back("Settings");
    expect(document.activeElement).toBe(keysRow);
    await end();
    expect(pages().map(({ page }) => page)).toEqual(["main"]);
  });

  it("goes there and back before the first slide ends without doubling a page", () => {
    slides();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Pages />);
    go("Open keys");
    back("Settings");
    expect(pages()).toEqual([
      { page: "main", held: false, leaving: false, inert: false, direction: "back" },
      { page: "keys", held: false, leaving: true, inert: true, direction: "back" },
    ]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
