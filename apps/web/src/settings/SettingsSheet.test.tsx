// @vitest-environment jsdom
import { DEFAULT_AUTONOMY } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSheet, type SettingsSheetProps } from "./SettingsSheet.tsx";

afterEach(cleanup);
const props = (): SettingsSheetProps => ({
  open: true,
  choices: { main: { provider: "openai", model: "saved" } },
  providers: [],
  keys: [],
  keyLayer: "online",
  catalog: "ready",
  dirty: false,
  onClose: vi.fn(),
  onChange: vi.fn(),
  onKeys: vi.fn(),
});
describe("settings sheet presentation ownership", () => {
  it("focuses the requested autonomy section after loading without stealing later edits", () => {
    const p = { ...props(), autonomy: DEFAULT_AUTONOMY, onAutonomy: vi.fn() };
    const view = render(<SettingsSheet {...p} focusSection="autonomy" loading />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close settings" }));
    view.rerender(<SettingsSheet {...p} focusSection="autonomy" />);
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Read information" }));
    const browsing = screen.getByRole("combobox", { name: "Browse websites" });
    browsing.focus();
    view.rerender(<SettingsSheet {...p} focusSection="autonomy" dirty />);
    expect(document.activeElement).toBe(browsing);
    expect(p.onAutonomy).not.toHaveBeenCalled();
  });
  it("keeps the active editor focused while the controlled close callback changes", () => {
    const latest = vi.fn();
    function Controller() {
      const [model, setModel] = useState("custom");
      return (
        <SettingsSheet
          {...props()}
          choices={{ main: { provider: "openai-compatible", model } }}
          onChange={(_role, value) => setModel(value?.model ?? "")}
          onClose={() => latest(model)}
        />
      );
    }
    render(<Controller />);
    const field = screen.getByLabelText("main custom model ID") as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: "custom-next" } });
    expect(field.value).toBe("custom-next");
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(latest).toHaveBeenCalledExactlyOnceWith("custom-next");
  });
  it("shows saved/unsaved and refresh states without changing current choices", () => {
    const p = props();
    const view = render(<SettingsSheet {...p} />);
    expect(screen.getByText("Saved choices")).toBeTruthy();
    view.rerender(<SettingsSheet {...p} dirty catalog="refreshing" />);
    expect(screen.getByText("Unsaved choices")).toBeTruthy();
    expect(screen.getByText("Refreshing the model catalog…")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "main model" }) as HTMLSelectElement).value).toBe(
      "saved",
    );
    expect(p.onChange).not.toHaveBeenCalled();
  });
  it("traps Tab, closes on Escape and suspends its keyboard owner for nested Keys", () => {
    const p = props();
    const view = render(<SettingsSheet {...p} />);
    const close = screen.getByRole("button", { name: "Close settings" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText("Use a local model"));
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    view.rerender(<SettingsSheet {...p} suspended />);
    expect(screen.queryByRole("dialog", { name: "Models and settings" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(p.onClose).not.toHaveBeenCalled();
    view.rerender(<SettingsSheet {...p} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledOnce();
  });
  it("keeps Stop reachable during a settings save and invokes only its provided action", () => {
    const p = props(),
      run = vi.fn(),
      save = vi.fn();
    const view = render(
      <SettingsSheet
        {...p}
        busy
        stop={{ label: "Stop", enabled: true, run }}
        save={{ enabled: true, run: save }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(run).toHaveBeenCalledOnce();
    const saving = screen.getByRole("button", { name: "Saving…" });
    expect(saving.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(saving);
    expect(save).not.toHaveBeenCalled();
    view.rerender(<SettingsSheet {...p} stop={{ label: "Stop", enabled: false, run }} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(run).toHaveBeenCalledOnce();
  });
  it("shows account models without prices, USD ceilings or inactive paid editors", () => {
    const p = props();
    render(
      <SettingsSheet
        {...p}
        choices={{
          main: { provider: "chatgpt", model: "account-model" },
          fast: {
            provider: "openai",
            model: "stored-paid",
            key: "deleted",
            price: { inputUSDPerMTok: 2, outputUSDPerMTok: 3 },
          },
        }}
        subscriptionModels={[{ id: "account-model", name: "Reported account model" }]}
        manualPrices={{ fast: { input: "2", output: "3" } }}
        budget={{ value: "8", useDefault: false, defaultUSD: 2, change: vi.fn() }}
      />,
    );
    expect(screen.getByRole("combobox", { name: "main model" })).toBeTruthy();
    expect(screen.getByText("openai · stored-paid")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "fast key" })).toBeNull();
    expect(screen.queryByLabelText(/USD|fast provider|fast model/)).toBeNull();
    expect(screen.queryByRole("group", { name: "Task spending ceiling" })).toBeNull();
    expect(screen.queryByText(/million tokens/)).toBeNull();
  });
  it("says a plan uses its own limits instead of asking for a price or a ceiling", () => {
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
    const ceiling = screen.getByRole("group", { name: "Task spending ceiling" });
    expect(within(ceiling).getByText("Uses your plan's limits.")).toBeTruthy();
    expect(within(ceiling).queryByRole("textbox")).toBeNull();
    expect(within(ceiling).queryByRole("checkbox")).toBeNull();
    const main = screen.getByRole("group", { name: "Main" });
    expect(
      within(main).getByText(
        "Uses your plan's limits. Use a key from this plan, not a pay-as-you-go key.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/million tokens/)).toBeNull();
    view.rerender(
      <SettingsSheet
        {...p}
        choices={{ main: plan, fast: { provider: "zai", model: "glm-5v-turbo", key: "zai" } }}
        budget={budget}
      />,
    );
    const paid = screen.getByRole("group", { name: "Task spending ceiling" });
    expect(within(paid).queryByText("Uses your plan's limits.")).toBeNull();
    expect(within(paid).getByRole("textbox", { name: "Task ceiling — USD" })).toBeTruthy();
  });
  it("keeps the sheet and the choice when Escape comes from a select", () => {
    const p = { ...props(), dirty: true, autonomy: DEFAULT_AUTONOMY, onAutonomy: vi.fn() };
    render(<SettingsSheet {...p} />);
    const select = screen.getByRole("combobox", { name: "Send messages" });
    select.focus();
    fireEvent.change(select, { target: { value: "handoff" } });
    fireEvent.keyDown(select, { key: "Escape" });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Models and settings" })).toBeTruthy();
    expect(p.onAutonomy).toHaveBeenCalledWith({ ...DEFAULT_AUTONOMY, send: "handoff" });
  });
  it("closes from the dim area only on a full click there", () => {
    const p = props();
    const { container } = render(<SettingsSheet {...p} />);
    const backdrop = container.querySelector(".settings-backdrop") as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.mouseDown(backdrop);
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("dialog", { name: "Models and settings" }));
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.click(backdrop);
    expect(p.onClose).toHaveBeenCalledOnce();
  });
  it("asks before Escape, the close button or the dim area discards unsaved choices", () => {
    const p = { ...props(), dirty: true };
    const { container } = render(<SettingsSheet {...p} />);
    const backdrop = container.querySelector(".settings-backdrop") as HTMLElement;
    for (const dismiss of [
      () => fireEvent.keyDown(window, { key: "Escape" }),
      () => fireEvent.click(screen.getByRole("button", { name: "Close settings" })),
      () => fireEvent.click(backdrop),
    ]) {
      dismiss();
      expect(screen.getByRole("alert").textContent).toBe("Discard unsaved changes?");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    }
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(p.onClose).toHaveBeenCalledOnce();
  });
  it("asks before Reload saved settings drops unsaved choices", () => {
    const p = { ...props(), onReload: vi.fn() };
    const view = render(<SettingsSheet {...p} dirty />);
    const reload = screen.getByRole("button", { name: "Reload saved settings" });
    fireEvent.click(reload);
    expect(screen.getByRole("alert").textContent).toBe("Discard unsaved changes?");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(p.onReload).not.toHaveBeenCalled();
    fireEvent.click(reload);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(p.onReload).toHaveBeenCalledOnce();
    expect(p.onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
    expect(document.activeElement).toBe(reload);
    view.rerender(<SettingsSheet {...p} dirty={false} />);
    fireEvent.click(reload);
    expect(p.onReload).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });
  it("returns focus to its opener after a click outside", () => {
    const p = props();
    const view = render(
      <>
        <button type="button">Open settings</button>
        <SettingsSheet {...p} open={false} />
      </>,
    );
    const opener = screen.getByRole("button", { name: "Open settings" });
    opener.focus();
    const sheet = (open: boolean) => (
      <>
        <button type="button">Open settings</button>
        <SettingsSheet {...p} open={open} />
      </>
    );
    view.rerender(sheet(true));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close settings" }));
    const backdrop = view.container.querySelector(".settings-backdrop") as HTMLElement;
    fireEvent.pointerDown(backdrop);
    // A pointer-down outside any control moves focus to the page body first.
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(backdrop);
    expect(p.onClose).toHaveBeenCalledOnce();
    view.rerender(sheet(false));
    expect(document.activeElement).toBe(opener);
  });
  it("lists every problem and ties Save's reason to it", () => {
    const p = props();
    const view = render(
      <SettingsSheet
        {...p}
        dirty
        validation={["Local: choose a valid model ID.", "Enter an explicit task ceiling in USD."]}
        save={{ enabled: false, run: vi.fn() }}
      />,
    );
    const save = screen.getByRole("button", { name: "Save settings" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(save.getAttribute("aria-describedby") ?? "");
    expect(
      within(reason as HTMLElement)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Local: choose a valid model ID.", "Enter an explicit task ceiling in USD."]);
    view.rerender(
      <SettingsSheet
        {...p}
        dirty
        catalog="offline"
        error="Settings could not be loaded. Your edits are kept. Choose Try again."
        onRefresh={vi.fn()}
        save={{ enabled: false, run: vi.fn() }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Save settings" }).getAttribute("aria-describedby"),
    ).toContain("settings-error");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    view.rerender(<SettingsSheet {...p} save={{ enabled: false, run: vi.fn() }} />);
    expect(
      document.getElementById(
        screen.getByRole("button", { name: "Save settings" }).getAttribute("aria-describedby") ??
          "",
      )?.textContent,
    ).toBe("Saved choices");
  });
});
