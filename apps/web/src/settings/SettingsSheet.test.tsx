// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
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
});
