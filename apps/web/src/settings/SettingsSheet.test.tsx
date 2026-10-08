// @vitest-environment jsdom
import { type AutonomyPolicy, DEFAULT_AUTONOMY } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRole, RoleChoice } from "./choices.ts";
import { SettingsSheet, type SettingsSheetProps } from "./SettingsSheet.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
const status = () =>
  document.getElementById(
    screen.getByRole("button", { name: "Save" }).getAttribute("aria-describedby")?.split(" ")[0] ??
      "",
  );

describe("settings inspector", () => {
  it("opens beside the page on the main provider, and on the autonomy choices when asked", () => {
    const view = render(<SettingsSheet {...props()} />);
    const main = screen.getByRole("region", { name: "Main model" });
    expect(document.activeElement).toBe(within(main).getByRole("combobox", { name: "Provider" }));
    expect(sheet().getAttribute("aria-modal")).toBe("false");
    view.unmount();
    const p = { ...props(), autonomy: DEFAULT_AUTONOMY, onAutonomy: vi.fn() };
    const later = render(<SettingsSheet {...p} focusSection="autonomy" loading />);
    later.rerender(<SettingsSheet {...p} focusSection="autonomy" />);
    const reading = screen.getByRole("radiogroup", { name: "Read information" });
    expect(document.activeElement).toBe(within(reading).getByRole("radio", { name: "Just do it" }));
    const browsing = within(screen.getByRole("radiogroup", { name: "Browse websites" })).getByRole(
      "radio",
      { name: "Just do it" },
    );
    browsing.focus();
    later.rerender(<SettingsSheet {...p} focusSection="autonomy" dirty />);
    expect(document.activeElement).toBe(browsing);
    expect(p.onAutonomy).not.toHaveBeenCalled();
  });
  it("chooses a provider, a model and a key from the keyboard alone, then saves", () => {
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
    pick("Key", "");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({
      main: { provider: "openai", model: "sample-large", key: "openai-key" },
    });
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
  it("asks before Escape or the close button discards unsaved changes", () => {
    const p = { ...props(), dirty: true };
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
  it("says in the footer what saving needs, and ties Save's reason to it", () => {
    vi.useFakeTimers();
    const p = props();
    const view = render(<SettingsSheet {...p} />);
    const save = () => screen.getByRole("button", { name: "Save" });
    expect(status()?.textContent).toBe("All changes saved");
    expect(save().getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
    view.rerender(<SettingsSheet {...p} dirty />);
    expect(status()?.textContent).toBe("Unsaved changes");
    expect(save().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(p.onReload).toHaveBeenCalledOnce();
    view.rerender(
      <SettingsSheet
        {...p}
        dirty
        validation={["Local: choose a valid model ID.", "Enter a limit per task in US dollars."]}
      />,
    );
    expect(
      within(status() as HTMLElement)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["Local: choose a valid model ID.", "Enter a limit per task in US dollars."]);
    expect(save().getAttribute("aria-disabled")).toBe("true");
    view.rerender(<SettingsSheet {...p} dirty />);
    fireEvent.click(save());
    expect(p.save?.run).toHaveBeenCalledOnce();
    view.rerender(<SettingsSheet {...p} dirty busy />);
    expect(status()?.textContent).toBe("Saving…");
    expect(save().getAttribute("aria-busy")).toBe("true");
    view.rerender(<SettingsSheet {...p} />);
    expect(status()?.textContent).toBe("Saved");
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(status()?.textContent).toBe("All changes saved");
    view.rerender(<SettingsSheet {...p} dirty error="Settings couldn't be saved. Try again." />);
    expect(screen.getByRole("alert").textContent).toBe("Settings couldn't be saved. Try again.");
    expect(save().getAttribute("aria-describedby")).toContain(screen.getByRole("alert").id);
  });
  it("slides Keys over itself, keeps the choices, and Back gives focus to the Add key pressed", () => {
    const p = props();
    const onBack = vi.fn();
    const keysPage = {
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
      preset: { requestId: 1, provider: "openai" as const },
      onBack,
    };
    const view = render(<SettingsSheet {...p} />);
    const add = within(screen.getByRole("region", { name: "Main model" })).getByRole("button", {
      name: "Add key",
    });
    fireEvent.click(add);
    expect(p.onKeys).toHaveBeenCalledWith("main", "openai", add);
    add.focus();
    view.rerender(<SettingsSheet {...p} keysPage={keysPage} />);
    expect(screen.getByRole("dialog", { name: "Keys" })).toBeTruthy();
    const keys = document.querySelector<HTMLElement>('[data-page="keys"]') as HTMLElement;
    expect(within(keys).getByRole("combobox", { name: "Provider" }).textContent).toBe("OpenAI");
    expect(add.closest("[inert]")).not.toBeNull();
    fireEvent.click(within(keys).getByRole("button", { name: "Settings" }));
    expect(onBack).toHaveBeenCalledOnce();
    view.rerender(<SettingsSheet {...p} />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(document.activeElement).toBe(
      within(screen.getByRole("region", { name: "Main model" })).getByRole("button", {
        name: "Add key",
      }),
    );
    expect(p.onChange).not.toHaveBeenCalled();
  });
  it("leaves on the page it showed, whatever Keys does while it closes", () => {
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
      const p = props();
      const keysPage = {
        keys: {
          health: { online: true },
          keys: [],
          loadError: null,
          busy: false,
          save: vi.fn(async () => ({ restart: false })),
          remove: vi.fn(async () => {}),
        },
        onBack: vi.fn(),
      };
      const view = render(<SettingsSheet {...p} />);
      view.rerender(<SettingsSheet {...p} open={false} keysPage={keysPage} />);
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: "Keys" })).toBeNull();
      view.rerender(<SettingsSheet {...p} keysPage={keysPage} />);
      view.rerender(<SettingsSheet {...p} open={false} />);
      expect(screen.getByRole("dialog", { name: "Keys" })).toBeTruthy();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    }
  });
  it("asks before closing over Keys with a key typed, even with no settings changed", () => {
    const p = props();
    const keysPage = {
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
      onBack: vi.fn(),
    };
    render(<SettingsSheet {...p} keysPage={keysPage} />);
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "fake-private-value" } });
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
        budget={{ value: "8", useDefault: false, defaultUSD: 2, change: vi.fn() }}
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
    const budget = { value: "8", useDefault: false, defaultUSD: 2, change: vi.fn() };
    const plan = { provider: "minimax-coding-plan", model: "MiniMax-M3", key: "token-plan" };
    const view = render(
      <SettingsSheet
        {...p}
        choices={{ main: plan, local: { provider: "ollama", model: "local-model" } }}
        budget={budget}
      />,
    );
    const spending = screen.getByRole("region", { name: "Spending" });
    expect(within(spending).getByText(/Your plan's own limits apply/)).toBeTruthy();
    expect(within(spending).queryByRole("textbox")).toBeNull();
    const main = screen.getByRole("region", { name: "Main model" });
    expect(within(main).getByText("Uses your plan's limits.")).toBeTruthy();
    expect(
      within(main).getByText("Use a key from this plan, not a pay-as-you-go key."),
    ).toBeTruthy();
    view.rerender(
      <SettingsSheet
        {...p}
        choices={{ main: plan, fast: { provider: "zai", model: "glm-5v-turbo", key: "zai" } }}
        budget={budget}
      />,
    );
    const paid = screen.getByRole("region", { name: "Spending" });
    expect(within(paid).getByRole("textbox", { name: "Custom limit" })).toBeTruthy();
    fireEvent.click(within(paid).getByRole("radio", { name: "Default ($2)" }));
    expect(budget.change).toHaveBeenCalledWith("8", true);
  });
  it("marks an autonomy choice that differs from the saved one", () => {
    const onAutonomy = vi.fn();
    const saved: AutonomyPolicy = DEFAULT_AUTONOMY;
    const view = render(
      <SettingsSheet {...props()} autonomy={saved} savedAutonomy={saved} onAutonomy={onAutonomy} />,
    );
    const send = screen.getByRole("radiogroup", { name: "Send messages" });
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
    expect(screen.getAllByRole("img", { name: "Changed" })).toHaveLength(1);
    expect(screen.getByText("Passwords, codes and card details")).toBeTruthy();
  });
  it("carries Stop on a phone, where the sheet covers the page, and leaves it to the page elsewhere", () => {
    const run = vi.fn();
    const stop = { label: "Stop", enabled: true, run };
    const view = render(<SettingsSheet {...props()} stop={stop} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    view.unmount();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(width < 760px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    try {
      const later = render(
        <SettingsSheet {...props()} stop={stop} taskControls={<p>Stopping…</p>} />,
      );
      fireEvent.click(within(sheet()).getByRole("button", { name: "Stop" }));
      expect(run).toHaveBeenCalledOnce();
      expect(within(sheet()).getByText("Stopping…")).toBeTruthy();
      // Stopped, the computer has no Stop to offer, and the sheet still says how it went.
      later.rerender(<SettingsSheet {...props()} taskControls={<p>Stopped.</p>} />);
      expect(within(sheet()).queryByRole("button", { name: "Stop" })).toBeNull();
      expect(within(sheet()).getByText("Stopped.")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("says Saved only after a save, not after an account step that was busy", () => {
    const p = props();
    const view = render(<SettingsSheet {...p} />);
    view.rerender(<SettingsSheet {...p} busy />);
    expect(status()?.textContent).toBe("All changes saved");
    view.rerender(<SettingsSheet {...p} />);
    expect(status()?.textContent).toBe("All changes saved");
  });
});
