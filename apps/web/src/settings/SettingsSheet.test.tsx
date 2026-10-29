// @vitest-environment jsdom
import { type AutonomyPolicy, DEFAULT_AUTONOMY } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRole, RoleChoice } from "./choices.ts";
import { AUTOSAVE_MS, SettingsSheet, type SettingsSheetProps } from "./SettingsSheet.tsx";
import { knownFixture } from "./testing.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const MODELS = [
  {
    id: "sample-large",
    name: "Sample Large",
    tier: "vision-tools" as const,
    computer: "generic" as const,
    coords: "pixels" as const,
    note: "Uses localDot's computer tool",
    contextTokens: 1000,
    inputUSDPerMTok: 3,
    outputUSDPerMTok: 15,
  },
];
const props = (): SettingsSheetProps => ({
  open: true,
  choices: { main: { provider: "openai", model: "sample-large", key: "openai-key" } },
  providers: [{ id: "openai", models: MODELS }],
  keys: [{ id: "openai-key", kind: "llm", provider: "openai" }],
  keyLayer: "online",
  catalog: "ready",
  dirty: false,
  onClose: vi.fn(),
  onChange: vi.fn(),
  onKeys: vi.fn(),
  onReload: vi.fn(),
  save: { enabled: true, run: vi.fn() },
});
const sheet = () => screen.getByRole("dialog", { name: "Settings" });
const asking = () =>
  screen.getByRole("group", { name: "Discard unsaved changes?" }).hasAttribute("data-shown");
const keysPanel = () => ({
  keys: {
    health: {
      online: true,
      audit: { ok: true },
      hairpin: { state: "active" as const, addresses: 1 },
    },
    keys: [],
    loadError: null,
    busy: false,
    save: vi.fn(async () => ({ restart: false })),
    remove: vi.fn(async () => {}),
  },
});
function onPhone() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(width < 700px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

// jsdom has no layout. Give the section scroller distinct positions so a misplaced navigation
// cannot pass just because every element reports zero.
function sectionLayout() {
  const tops: Record<string, number> = { dot: 0, models: 600, autonomy: 1200, keys: 1800 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const scroller = this.closest<HTMLElement>(".ui-sheet-body");
    const top = this.dataset.section
      ? 80 + (tops[this.dataset.section] ?? 0) - (scroller?.scrollTop ?? 0)
      : 80;
    return {
      top,
      bottom: top + 100,
      left: 0,
      right: 600,
      width: 600,
      height: 100,
      x: 0,
      y: top,
      toJSON() {},
    };
  });
  const resized = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe(element: HTMLElement) {
        if (element.id === "settings-sheet-body") resized.add(this.callback);
      }
      disconnect() {
        resized.delete(this.callback);
      }
    },
  );
  return {
    tops,
    resize: () =>
      act(() => {
        for (const callback of resized) callback();
      }),
  };
}
const settingsScroll = () => {
  const element = sheet().querySelector<HTMLElement>(".ui-sheet-body");
  if (!element) throw new Error("Settings scroll container missing");
  return element;
};
const currentSection = () =>
  screen.getByRole("navigation", { name: "Settings sections" }).querySelector("[aria-current=true]")
    ?.textContent;

describe("settings inspector", () => {
  it("shows only the selected page, retaining visited forms without layout shifts", () => {
    const layout = sectionLayout();
    const p = {
      ...props(),
      keysPanel: keysPanel(),
      persona: { value: "coder" as const, onChange: vi.fn() },
    };
    const view = render(<SettingsSheet {...p} loading sectionRequest={1} />);
    expect(settingsScroll().scrollTop).toBe(0);
    expect(currentSection()).toBe("Your dot");
    expect(screen.queryByRole("region", { name: "Models" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    expect(currentSection()).toBe("Models");
    view.rerender(<SettingsSheet {...p} sectionRequest={1} />);
    settingsScroll().scrollTop = 75;
    layout.resize();
    expect(settingsScroll().scrollTop).toBe(75);
    expect(screen.queryByRole("region", { name: "Your dot" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    fireEvent.change(within(screen.getByRole("region", { name: "Keys" })).getByLabelText("Key"), {
      target: { value: "fake-private-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    expect(settingsScroll().scrollTop).toBe(0);
    expect(screen.queryByRole("region", { name: "Keys" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    expect(
      (
        within(screen.getByRole("region", { name: "Keys" })).getByLabelText(
          "Key",
        ) as HTMLInputElement
      ).value,
    ).toBe("fake-private-value");
  });
  it("honors repeated explicit requests and returns focus to the opener", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const p = { ...props(), keysPanel: keysPanel() };
    const view = render(<SettingsSheet {...p} section="models" sectionRequest={1} />);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Models" }));
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    view.rerender(<SettingsSheet {...p} section="models" sectionRequest={2} />);
    expect(currentSection()).toBe("Models");
    expect(settingsScroll().scrollTop).toBe(0);
    view.rerender(<SettingsSheet {...p} open={false} />);
    expect(document.activeElement).toBe(button);
    button.remove();
  });
  it("brings a tip asked for into view once it shows, lights it and focuses its field", () => {
    const locked = keysPanel();
    const unlocking = {
      keysPanel: {
        keys: {
          ...locked.keys,
          health: { ...locked.keys.health, vault: { backend: "file", state: "locked" as const } },
          unlock: vi.fn(async () => {}),
        },
      },
    };
    const p = { ...props(), keysPanel: keysPanel() };
    const view = render(
      <SettingsSheet {...p} section="keys" sectionRequest={1} tip="keys-unlock" />,
    );
    expect(document.getElementById("keys-unlock")).toBeNull();
    // Key protection answers after Keys opened: the form shows, and the tip with it.
    view.rerender(
      <SettingsSheet {...p} {...unlocking} section="keys" sectionRequest={1} tip="keys-unlock" />,
    );
    const tip = document.getElementById("keys-unlock");
    expect(tip?.hasAttribute("data-tip")).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("Passphrase"));
    tip?.dispatchEvent(new Event("animationend"));
    expect(tip?.hasAttribute("data-tip")).toBe(false);
    view.rerender(
      <SettingsSheet {...p} {...unlocking} section="keys" sectionRequest={1} tip="keys-unlock" />,
    );
    expect(tip?.hasAttribute("data-tip")).toBe(false);
  });
  it("opens on what dot knows when asked", () => {
    const knowledge = {
      skills: [],
      skillsPhase: "ready" as const,
      memory: { user: "", memory: "Prefers short replies." },
      memoryPhase: "ready" as const,
      reloadSkills: vi.fn(),
      rereadMemory: vi.fn(),
    };
    const fact = {
      id: "01JXYZ0000000000000000AAAA",
      file: "MEMORY.md" as const,
      text: "Prefers short replies.",
      source: { kind: "user" as const },
      at: "2026-10-08",
      pinned: false,
      revision: "0123456789abcdef",
    };
    render(
      <SettingsSheet
        {...props()}
        knowledge={knowledge}
        known={knownFixture({ files: { "USER.md": [], "MEMORY.md": [fact] } })}
        section="knowledge"
        sectionRequest={1}
      />,
    );
    act(() => screen.getByRole("radio", { name: "Notes" }).click());
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "What dot knows" }));
    expect(screen.getByRole("region", { name: "What dot knows" }).textContent).toContain(
      "Prefers short replies.",
    );
  });
  it("lights the section a sidebar row goes to", () => {
    render(<SettingsSheet {...props()} keysPanel={keysPanel()} />);
    const index = screen.getByRole("navigation", { name: "Settings sections" });
    const current = () =>
      within(index)
        .getAllByRole("button")
        .filter((row) => row.getAttribute("aria-current") === "true")
        .map((row) => row.textContent);
    expect(current()).toEqual(["Models"]);
    fireEvent.click(within(index).getByRole("button", { name: "Keys" }));
    expect(current()).toEqual(["Keys"]);
  });
  it("chooses a provider, a model and a key from the keyboard alone, and saves on its own", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    function Controller() {
      const [choices, setChoices] = useState<Partial<Record<ModelRole, RoleChoice>>>({});
      return (
        <SettingsSheet
          {...props()}
          choices={choices}
          dirty={!!choices.main}
          onChange={(role, value) => setChoices((old) => ({ ...old, [role]: value }))}
          save={{ enabled: !!choices.main?.key, run: () => save(choices) }}
        />
      );
    }
    render(<Controller />);
    const main = () => screen.getByRole("region", { name: "Main model" });
    const pick = (name: string, typed: string) => {
      const control = within(main()).getByRole("combobox", { name });
      control.focus();
      fireEvent.keyDown(control, { key: "ArrowDown" });
      const search = screen.queryByRole("combobox", { name: `Search: ${name}` });
      if (search) {
        fireEvent.change(search, { target: { value: typed } });
        fireEvent.keyDown(search, { key: "Enter" });
      } else {
        fireEvent.keyDown(control, { key: "Enter" });
      }
    };
    pick("Provider", "openai");
    pick("Model", "large");
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_MS);
    });
    expect(save).not.toHaveBeenCalled();
    pick("Key", "");
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_MS - 1);
    });
    expect(save).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({
      main: { provider: "openai", model: "sample-large", key: "openai-key" },
    });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
  it("never saves on its own while saving failed, until the next edit", () => {
    vi.useFakeTimers();
    const p = props();
    const view = render(<SettingsSheet {...p} dirty error="These settings could not be saved." />);
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_MS * 4);
    });
    expect(p.save?.run).not.toHaveBeenCalled();
    view.rerender(<SettingsSheet {...p} dirty choices={{}} />);
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_MS);
    });
    expect(p.save?.run).toHaveBeenCalledOnce();
  });
  it("saves edits on their way before closing, and closes once they are saved", async () => {
    let settle = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    const p = { ...props(), save: { enabled: true, run } };
    const view = render(<SettingsSheet {...p} dirty />);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(asking()).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    view.rerender(<SettingsSheet {...p} dirty busy />);
    view.rerender(<SettingsSheet {...p} />);
    expect(p.onClose).not.toHaveBeenCalled();
    await act(async () => settle());
    expect(p.onClose).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });
  it("keeps the sheet and the choice when Escape closes a picker inside it", () => {
    const p = { ...props(), dirty: true };
    render(<SettingsSheet {...p} />);
    const provider = within(screen.getByRole("region", { name: "Main model" })).getByRole(
      "combobox",
      { name: "Provider" },
    );
    fireEvent.keyDown(provider, { key: "ArrowDown" });
    const search = screen.getByRole("combobox", { name: "Search: Provider" });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(provider.getAttribute("aria-expanded")).toBe("false");
    expect(asking()).toBe(false);
    expect(sheet()).toBeTruthy();
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.onChange).not.toHaveBeenCalled();
  });
  it("reveals invalid fields on close or Escape without a discard prompt", () => {
    const p = {
      ...props(),
      keysPanel: keysPanel(),
      dirty: true,
      validation: ["Choose a main provider and model."],
      save: { enabled: false, run: vi.fn() },
    };
    render(<SettingsSheet {...p} section="keys" />);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(asking()).toBe(false);
    expect(currentSection()).toBe("Models");
    expect(screen.getByRole("alert").textContent).toContain("Choose a main provider and model.");
    fireEvent.keyDown(sheet(), { key: "Escape" });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(asking()).toBe(false);
  });
  it("asks before Revert drops unsaved changes", () => {
    const p = {
      ...props(),
      validation: ["Choose a model for the main role."],
      save: { enabled: false, run: vi.fn() },
    };
    const view = render(<SettingsSheet {...p} dirty />);
    const revert = screen.getByRole("button", { name: "Revert" });
    revert.focus();
    fireEvent.click(revert);
    expect(asking()).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(asking()).toBe(false);
    expect(p.onReload).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(revert);
    fireEvent.click(revert);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(p.onReload).toHaveBeenCalledOnce();
    expect(p.onClose).not.toHaveBeenCalled();
    expect(asking()).toBe(false);
    expect(document.activeElement).toBe(sheet());
    view.rerender(<SettingsSheet {...p} dirty={false} />);
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
  });
  it("says when the model list may be out of date, and offers Refresh", () => {
    const onRefresh = vi.fn();
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    const view = render(
      <SettingsSheet {...props()} catalog="ready" catalogAt={at} onRefresh={onRefresh} />,
    );
    expect(screen.getByText("Model list updated 5 min ago")).toBeTruthy();
    view.rerender(
      <SettingsSheet {...props()} catalog="stale" catalogAt={at} onRefresh={onRefresh} />,
    );
    expect(screen.getByText("Model list from 5 min ago may be out of date")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
  it("keeps save feedback in the footer and explains invalid or failed saves", () => {
    const p = props();
    const view = render(<SettingsSheet {...p} dirty />);
    expect(document.querySelector(".settings-footer")).not.toBeNull();
    view.rerender(
      <SettingsSheet
        {...p}
        dirty
        validation={["Local: choose a valid model ID.", "Enter a limit per task in US dollars."]}
      />,
    );
    const footer = document.querySelector(".settings-footer") as HTMLElement;
    expect(
      within(footer)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["Local: choose a valid model ID.", "Enter a limit per task in US dollars."]);
    expect(within(footer).getByRole("button", { name: "Revert" })).toBeTruthy();
    view.rerender(<SettingsSheet {...p} dirty error="Settings couldn't be saved. Try again." />);
    expect(screen.getByRole("alert").textContent).toBe("Settings couldn't be saved. Try again.");
    view.rerender(<SettingsSheet {...p} />);
    expect(document.querySelector(".settings-footer")).not.toBeNull();
  });
  it("holds Keys as a section: Add key from a role opens its form for that provider", () => {
    const p = props();
    const view = render(
      <SettingsSheet
        {...p}
        choices={{ main: { provider: "openai", model: "sample-large" } }}
        keys={[]}
        keysPanel={{
          ...keysPanel(),
          keys: {
            ...keysPanel().keys,
            keys: [
              {
                id: "weather",
                kind: "http",
                hosts: ["api.weather.example"],
                createdAt: "t",
                updatedAt: "t",
              },
            ],
          },
        }}
      />,
    );
    expect(screen.queryByRole("region", { name: "Keys" })).toBeNull();
    const add = within(screen.getByRole("region", { name: "Main model" })).getByRole("button", {
      name: "Add key",
    });
    fireEvent.click(add);
    expect(p.onKeys).toHaveBeenCalledWith("main", "openai", add);
    view.rerender(
      <SettingsSheet
        {...p}
        choices={{ main: { provider: "openai", model: "sample-large" } }}
        keys={[]}
        section="keys"
        sectionRequest={1}
        keysPanel={{
          ...keysPanel(),
          keys: {
            ...keysPanel().keys,
            keys: [
              {
                id: "weather",
                kind: "http",
                hosts: ["api.weather.example"],
                createdAt: "t",
                updatedAt: "t",
              },
            ],
          },
          preset: { requestId: 1, provider: "openai" as const },
        }}
      />,
    );
    const form = within(screen.getByRole("region", { name: "Keys" })).getByRole("form", {
      name: "Add a key",
    });
    expect(within(form).getByRole("combobox", { name: "Provider" }).textContent).toBe("OpenAI");
    expect(p.onChange).not.toHaveBeenCalled();
  });
  it("on a phone, lists the sections with what each holds and pushes into one", () => {
    onPhone();
    const p = {
      ...props(),
      autonomy: DEFAULT_AUTONOMY,
      onAutonomy: vi.fn(),
      persona: { value: "coder" as const, onChange: vi.fn() },
    };
    render(<SettingsSheet {...p} keysPanel={keysPanel()} />);
    expect(sheet()).toBeTruthy();
    const row = (name: RegExp) => screen.getByRole("button", { name });
    expect(row(/^Your dot/).textContent).toBe("Your dotCoder");
    expect(row(/^Models/).textContent).toBe("ModelsSample Large");
    expect(row(/^Autonomy/).textContent).toBe("AutonomyBalanced");
    fireEvent.click(row(/^Autonomy/));
    expect(screen.getByRole("dialog", { name: "Autonomy" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Start from" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(sheet()).toBeTruthy();
  });
  it("on a phone, names a plan's model by its own name", () => {
    onPhone();
    render(
      <SettingsSheet
        {...props()}
        choices={{ main: { provider: "claude-code", model: "sonnet" } }}
        subscriptionModels={[{ id: "sonnet", name: "Claude Sonnet" }]}
      />,
    );
    expect(screen.getByRole("button", { name: /^Models/ }).textContent).toBe("ModelsClaude Sonnet");
  });
  it("on a phone, goes to the section asked for and leaves on the page it showed", () => {
    onPhone();
    // Something still moving keeps the closing sheet on the page, as a browser's transitions do.
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [
        {
          effect: { getComputedTiming: () => ({ endTime: 1000 }) },
          finished: new Promise(() => {}),
        },
      ],
    });
    try {
      const p = { ...props(), keysPanel: keysPanel() };
      const view = render(<SettingsSheet {...p} section="keys" sectionRequest={1} />);
      expect(screen.getByRole("dialog", { name: "Keys" })).toBeTruthy();
      view.rerender(<SettingsSheet {...p} open={false} sectionRequest={2} />);
      expect(screen.getByRole("dialog", { name: "Keys" })).toBeTruthy();
      view.rerender(<SettingsSheet {...p} sectionRequest={3} />);
      expect(sheet()).toBeTruthy();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    }
  });
  it("reveals a typed key on close without a discard prompt", () => {
    const p = props();
    render(<SettingsSheet {...p} keysPanel={keysPanel()} section="keys" />);
    const keys = screen.getByRole("region", { name: "Keys" });
    fireEvent.change(within(keys).getByLabelText("Key"), {
      target: { value: "fake-private-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(asking()).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("Save or cancel the key");
    expect(p.onClose).not.toHaveBeenCalled();
  });
  it("shows the ChatGPT plan without prices, a spending limit or the optional roles", () => {
    render(
      <SettingsSheet
        {...props()}
        choices={{
          main: { provider: "chatgpt", model: "account-model" },
          fast: { provider: "openai", model: "stored-paid", key: "deleted" },
        }}
        subscriptionModels={[{ id: "account-model", name: "Reported account model" }]}
        manualPrices={{ fast: { input: "2", output: "3" } }}
        spending={{ value: { on: true, task: "8", day: "" }, change: vi.fn() }}
      />,
    );
    const main = screen.getByRole("region", { name: "Main model" });
    expect(within(main).getByRole("combobox", { name: "Model" }).textContent).toBe(
      "Reported account model",
    );
    expect(within(main).queryByRole("combobox", { name: "Key" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Fast model" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(screen.queryByRole("region", { name: "Spending" })).toBeNull();
    expect(screen.queryByText(/million tokens/)).toBeNull();
  });
  it("says a plan uses its own limits instead of asking for a price or a limit", () => {
    const p = props();
    const spending = { value: { on: false, task: "", day: "" }, change: vi.fn() };
    const plan = { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "token-plan" };
    const view = render(
      <SettingsSheet
        {...p}
        choices={{ main: plan, local: { provider: "ollama", model: "local-model" } }}
        spending={spending}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Spending" }));
    const section = screen.getByRole("region", { name: "Spending" });
    expect(within(section).getByText(/Your plan's own limits apply/)).toBeTruthy();
    expect(within(section).queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    const main = screen.getByRole("region", { name: "Main model" });
    expect(within(main).getByText(/Uses your plan's limits\./)).toBeTruthy();
    expect(
      within(main).getByText(/Use a key from this plan, not a pay-as-you-go key\./),
    ).toBeTruthy();
    view.rerender(
      <SettingsSheet
        {...p}
        choices={{ main: plan, fast: { provider: "zai", model: "glm-5v-turbo", key: "zai" } }}
        spending={spending}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Spending" }));
    const paid = screen.getByRole("region", { name: "Spending" });
    const limit = within(paid).getByRole("switch", { name: "Spending limit" });
    expect((limit as HTMLInputElement).checked).toBe(false);
    fireEvent.click(limit);
    expect(spending.change).toHaveBeenCalledWith({ on: true, task: "", day: "" });
  });
  it("offers each check-in off, and a number once one is on", () => {
    const change = vi.fn();
    const off = { on: false, value: "150" };
    render(
      <SettingsSheet
        {...props()}
        autonomy={DEFAULT_AUTONOMY}
        onAutonomy={vi.fn()}
        checkIns={{
          value: { steps: off, failures: { on: true, value: "5" }, actions: off },
          change,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Autonomy" }));
    const steps = screen.getByRole("switch", { name: "After a number of steps" });
    expect((steps as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("textbox", { name: "Steps" })).toBeNull();
    fireEvent.click(steps);
    expect(change).toHaveBeenCalledWith("steps", { on: true, value: "150" });
    fireEvent.change(screen.getByRole("textbox", { name: "Failed actions" }), {
      target: { value: "7x" },
    });
    expect(change).toHaveBeenLastCalledWith("failures", { on: true, value: "7" });
  });
  it("marks an autonomy choice that differs from the saved one", () => {
    const onAutonomy = vi.fn();
    const saved: AutonomyPolicy = DEFAULT_AUTONOMY;
    const view = render(
      <SettingsSheet {...props()} autonomy={saved} savedAutonomy={saved} onAutonomy={onAutonomy} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Autonomy" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose for each kind of action" }));
    const send = screen.getByRole("radiogroup", { name: "Send as you" });
    fireEvent.click(within(send).getByRole("radio", { name: "Just do it" }));
    expect(onAutonomy).toHaveBeenCalledWith({ ...DEFAULT_AUTONOMY, send: "act" });
    expect(screen.queryByRole("img", { name: "Changed" })).toBeNull();
    view.rerender(
      <SettingsSheet
        {...props()}
        autonomy={{ ...DEFAULT_AUTONOMY, send: "act" }}
        savedAutonomy={saved}
        onAutonomy={onAutonomy}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Autonomy" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose for each kind of action" }));
    expect(screen.getAllByRole("img", { name: "Changed" })).toHaveLength(1);
    expect(screen.getByText("Passwords, codes and card details")).toBeTruthy();
  });
  it("offers Shut down on every size, and on a phone also the task's Stop and how it went", () => {
    const shutDown = vi.fn();
    const note = { line: "Stopped. Your computer is paused." };
    const view = render(
      <SettingsSheet
        {...props()}
        stop={{ label: "Shut down", enabled: true, run: shutDown }}
        stopNote={note}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Your computer" }));
    fireEvent.click(within(sheet()).getByRole("button", { name: "Shut down" }));
    expect(shutDown).toHaveBeenCalledOnce();
    expect(within(sheet()).queryByText(note.line)).toBeNull();
    view.unmount();
    const run = vi.fn();
    const stop = { label: "Stop", enabled: true, run, task: true };
    onPhone();
    {
      const later = render(<SettingsSheet {...props()} stop={stop} />);
      fireEvent.click(within(sheet()).getByRole("button", { name: "Stop" }));
      expect(run).toHaveBeenCalledOnce();
      // Stopped, the task has no Stop to offer, and its row still says how it went, with what
      // couldn't be confirmed behind Details.
      later.rerender(
        <SettingsSheet
          {...props()}
          stopNote={{ ...note, details: ["Couldn't confirm that your keys were locked away."] }}
        />,
      );
      expect(within(sheet()).queryByRole("button", { name: "Stop" })).toBeNull();
      expect(within(sheet()).getByText(note.line)).toBeTruthy();
      const details = within(sheet()).getByRole("button", { name: "Details" });
      expect(details.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(details);
      expect(
        within(sheet()).getByText("Couldn't confirm that your keys were locked away."),
      ).toBeTruthy();
    }
  });

  it("offers Update for a new version even with the computer off, and keeps the row while it runs", () => {
    const run = vi.fn();
    const update = { available: true, busy: false, error: null, run };
    const view = render(<SettingsSheet {...props()} update={update} />);
    fireEvent.click(screen.getByRole("button", { name: "Your computer" }));
    expect(within(sheet()).getByText("New version ready")).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Update" }));
    expect(run).toHaveBeenCalledOnce();
    view.rerender(
      <SettingsSheet
        {...props()}
        stop={{ label: "Shut down", enabled: true, run: vi.fn() }}
        update={{ ...update, busy: true }}
      />,
    );
    expect(within(sheet()).getByText("Updating…")).toBeTruthy();
    expect(within(sheet()).getByRole("button", { name: "Update" }).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(
      within(sheet()).getByRole("button", { name: "Shut down" }).getAttribute("aria-disabled"),
    ).toBe("true");
    view.rerender(<SettingsSheet {...props()} update={{ ...update, available: false }} />);
    expect(within(sheet()).queryByText(/new version/)).toBeNull();
  });

  it("holds Update, saying why, while dot works or you hold the computer", () => {
    const run = vi.fn();
    render(
      <SettingsSheet
        {...props()}
        update={{
          available: true,
          busy: false,
          error: null,
          waitReason: "Wait for dot to finish",
          run,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Your computer" }));
    const button = within(sheet()).getByRole("button", { name: "Update" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Your computer" }));
    expect(within(sheet()).getByText("New version ready")).toBeTruthy();
  });

  it("offers Start fresh for the computer behind a confirm, and holds it while dot works", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const run = vi.fn();
    const freshStart = { available: true, busy: false, error: null, run };
    const view = render(<SettingsSheet {...props()} freshStart={freshStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Your computer" }));
    expect(
      within(sheet()).getByText("Erases your computer's files. Your sign\u2011ins stay."),
    ).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Erase…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Start fresh?" });
    expect(
      within(dialog).getByText("Your computer's files are erased. Your sign-ins are kept."),
    ).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start fresh" }));
    expect(run).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(300);
    });

    view.rerender(
      <SettingsSheet
        {...props()}
        freshStart={{ ...freshStart, waitReason: "Wait for dot to finish" }}
      />,
    );
    const held = within(sheet()).getByRole("button", { name: "Erase…" });
    expect(held.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(held);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(run).toHaveBeenCalledOnce();

    view.rerender(
      <SettingsSheet
        {...props()}
        freshStart={{ ...freshStart, error: "Starting fresh didn't finish. Try again." }}
      />,
    );
    expect(within(sheet()).getByText("Starting fresh didn't finish. Try again.")).toBeTruthy();
  });

  it("offers Auto, Sharp and Smooth for the stream in Your computer, on every size", () => {
    const change = vi.fn();
    const stream = { value: "auto" as const, saved: true, change };
    const view = render(<SettingsSheet {...props()} stream={stream} />);
    fireEvent.click(screen.getByRole("button", { name: "Your computer" }));
    const choice = within(sheet()).getByRole("radiogroup", { name: "Stream quality" });
    expect(within(sheet()).getByRole("button", { name: "Your computer" })).toBeTruthy();
    expect(
      within(choice)
        .getAllByRole("radio")
        .map((radio) => [radio.textContent, radio.getAttribute("aria-checked")]),
    ).toEqual([
      ["Auto", "true"],
      ["Sharp", "false"],
      ["Smooth", "false"],
    ]);
    fireEvent.click(within(choice).getByRole("radio", { name: "Smooth" }));
    expect(change).toHaveBeenCalledWith("smooth");
    view.rerender(<SettingsSheet {...props()} stream={{ ...stream, saved: false }} />);
    expect(within(sheet()).getByText(/This browser couldn't save it/)).toBeTruthy();
    view.unmount();
    onPhone();
    render(<SettingsSheet {...props()} stream={stream} />);
    fireEvent.click(within(sheet()).getByRole("button", { name: /^Your computer/ }));
    const page = screen.getByRole("dialog", { name: "Your computer" });
    expect(within(page).getByRole("radiogroup", { name: "Stream quality" })).toBeTruthy();
  });
});

describe("Settings Done", () => {
  it("keeps invalid changes and explains them instead of offering to discard", () => {
    onPhone();
    const p = {
      ...props(),
      dirty: true,
      save: { enabled: false, run: vi.fn() },
      validation: ["Choose a main provider and model."],
    };
    render(<SettingsSheet {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(asking()).toBe(false);
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.save.run).not.toHaveBeenCalled();
    expect(screen.getAllByText("Choose a main provider and model.").length).toBeGreaterThan(0);
  });
  it("waits for a busy save and closes only after changes are saved", () => {
    onPhone();
    const p = { ...props(), dirty: true, busy: true, save: { enabled: false, run: vi.fn() } };
    const view = render(<SettingsSheet {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(asking()).toBe(false);
    expect(p.onClose).not.toHaveBeenCalled();
    view.rerender(<SettingsSheet {...p} busy={false} dirty={false} />);
    expect(p.onClose).toHaveBeenCalledOnce();
  });
  it("saves a valid change immediately without waiting for autosave", async () => {
    onPhone();
    vi.useFakeTimers();
    let finish!: () => void;
    const p = {
      ...props(),
      dirty: true,
      save: {
        enabled: true,
        run: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        ),
      },
    };
    const view = render(<SettingsSheet {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(asking()).toBe(false);
    expect(p.save.run).toHaveBeenCalledOnce();
    expect(p.onClose).not.toHaveBeenCalled();
    view.rerender(<SettingsSheet {...p} dirty={false} />);
    await act(async () => finish());
    expect(p.onClose).toHaveBeenCalledOnce();
  });
});
