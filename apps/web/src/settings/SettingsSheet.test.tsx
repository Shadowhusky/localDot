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

describe("settings inspector", () => {
  it("opens over a dimmed page on the main provider, and on the autonomy choices when asked", () => {
    const view = render(<SettingsSheet {...props()} />);
    const main = screen.getByRole("region", { name: "Main model" });
    expect(document.activeElement).toBe(within(main).getByRole("combobox", { name: "Provider" }));
    expect(sheet().getAttribute("aria-modal")).toBe("true");
    view.unmount();
    const p = { ...props(), autonomy: DEFAULT_AUTONOMY, onAutonomy: vi.fn() };
    const later = render(<SettingsSheet {...p} section="autonomy" sectionRequest={1} loading />);
    later.rerender(<SettingsSheet {...p} section="autonomy" sectionRequest={1} />);
    const preset = screen.getByRole("radiogroup", { name: "Start from" });
    expect(document.activeElement).toBe(within(preset).getByRole("radio", { name: "Balanced" }));
    const careful = within(preset).getByRole("radio", { name: "Careful" });
    careful.focus();
    later.rerender(<SettingsSheet {...p} section="autonomy" sectionRequest={1} dirty />);
    expect(document.activeElement).toBe(careful);
    expect(p.onAutonomy).not.toHaveBeenCalled();
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
  it("asks before Escape or the close button discards edits that can't be saved", () => {
    const p = { ...props(), dirty: true, save: { enabled: false, run: vi.fn() } };
    render(<SettingsSheet {...p} />);
    for (const dismiss of [
      () => fireEvent.keyDown(sheet(), { key: "Escape" }),
      () => fireEvent.click(screen.getByRole("button", { name: "Close settings" })),
    ]) {
      dismiss();
      expect(asking()).toBe(true);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    }
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(p.onClose).toHaveBeenCalledOnce();
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
  it("shows a footer only for what keeps edits from saving, or a save that failed", () => {
    const p = props();
    const view = render(<SettingsSheet {...p} dirty />);
    expect(document.querySelector(".settings-footer")).toBeNull();
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
    expect(document.querySelector(".settings-footer")).toBeNull();
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
    const keys = screen.getByRole("region", { name: "Keys" });
    expect(within(keys).queryByRole("form", { name: "Add a key" })).toBeNull();
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
    const p = { ...props(), autonomy: DEFAULT_AUTONOMY, onAutonomy: vi.fn() };
    render(<SettingsSheet {...p} keysPanel={keysPanel()} />);
    expect(sheet()).toBeTruthy();
    const row = (name: RegExp) => screen.getByRole("button", { name });
    expect(row(/^Models/).textContent).toBe("ModelsSample Large");
    expect(row(/^Autonomy/).textContent).toBe("AutonomyBalanced");
    fireEvent.click(row(/^Autonomy/));
    expect(screen.getByRole("dialog", { name: "Autonomy" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Start from" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(sheet()).toBeTruthy();
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
  it("asks before closing with a key typed, even with no settings changed", () => {
    const p = props();
    render(<SettingsSheet {...p} keysPanel={keysPanel()} />);
    const keys = screen.getByRole("region", { name: "Keys" });
    fireEvent.change(within(keys).getByLabelText("Key"), {
      target: { value: "fake-private-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(asking()).toBe(true);
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
    const section = screen.getByRole("region", { name: "Spending" });
    expect(within(section).getByText(/Your plan's own limits apply/)).toBeTruthy();
    expect(within(section).queryByRole("textbox")).toBeNull();
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
    fireEvent.click(within(sheet()).getByRole("button", { name: "Shut down" }));
    expect(shutDown).toHaveBeenCalledOnce();
    expect(within(sheet()).queryByText(note.line)).toBeNull();
    view.unmount();
    const run = vi.fn();
    const stop = { label: "Stop", enabled: true, run };
    onPhone();
    {
      const later = render(<SettingsSheet {...props()} stop={stop} />);
      fireEvent.click(within(sheet()).getByRole("button", { name: "Stop" }));
      expect(run).toHaveBeenCalledOnce();
      // Stopped, the computer has no Stop to offer, and its row still says how it went, with
      // what couldn't be confirmed behind Details.
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
    expect(within(sheet()).getByText("A new version of your computer is ready")).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Update" }));
    expect(run).toHaveBeenCalledOnce();
    view.rerender(
      <SettingsSheet
        {...props()}
        stop={{ label: "Shut down", enabled: true, run: vi.fn() }}
        update={{ ...update, busy: true }}
      />,
    );
    expect(within(sheet()).getByText("Updating your computer…")).toBeTruthy();
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
    const button = within(sheet()).getByRole("button", { name: "Update" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(run).not.toHaveBeenCalled();
    expect(within(sheet()).getByText("A new version of your computer is ready")).toBeTruthy();
  });

  it("offers Start fresh for the computer behind a confirm, and holds it while dot works", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const run = vi.fn();
    const freshStart = { available: true, busy: false, error: null, run };
    const view = render(<SettingsSheet {...props()} freshStart={freshStart} />);
    expect(
      within(sheet()).getByText("Erases your computer's files. Your sign-ins stay."),
    ).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Start fresh" }));
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
    const held = within(sheet()).getByRole("button", { name: "Start fresh" });
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
    expect(within(sheet()).getByRole("radiogroup", { name: "Stream quality" })).toBeTruthy();
  });
});
