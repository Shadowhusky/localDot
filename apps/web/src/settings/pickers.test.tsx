// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyRecord } from "../keys/keys-api.ts";
import type { PickerModel, RoleChoice } from "./choices.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { ProviderPicker } from "./ProviderPicker.tsx";
import { RoleEditor } from "./RoleEditor.tsx";

afterEach(cleanup);
const models: PickerModel[] = [
  {
    id: "text-a",
    name: "Text fixture",
    tier: "text-only",
    computer: "none",
    coords: "pixels",
    note: "Can use files and the shell, not the screen",
    contextTokens: 1000,
    inputUSDPerMTok: 1,
    outputUSDPerMTok: 2,
  },
  {
    id: "summary-b",
    name: "Summary fixture",
    tier: "no-tools",
    computer: "none",
    coords: "pixels",
    note: "Cannot call tools",
    contextTokens: 1000,
    inputUSDPerMTok: 1,
    outputUSDPerMTok: 2,
  },
];
const stored: KeyRecord = {
  id: "inherited-key",
  kind: "llm",
  provider: "openai",
  createdAt: "t",
  updatedAt: "t",
};
describe("provider/model/role presentation", () => {
  it("shows registry groups, unavailable providers and a separate ChatGPT choice", () => {
    render(<ProviderPicker modelRole="main" value="" onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Subscription" })).toBeTruthy();
    expect(
      screen
        .getByRole("option", { name: "Amazon Bedrock — available in a later release" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Search main providers"), { target: { value: "chat" } });
    expect(screen.getByRole("option", { name: "ChatGPT plan" })).toBeTruthy();
  });
  it("retains the canonical selected provider through filtered searches", () => {
    const change = vi.fn();
    render(<ProviderPicker modelRole="main" value="google" onChange={change} />);
    fireEvent.change(screen.getByLabelText("Search main providers"), { target: { value: "groq" } });
    expect(
      (screen.getByRole("combobox", { name: "main provider" }) as HTMLSelectElement).value,
    ).toBe("google");
    expect(change).not.toHaveBeenCalled();
  });
  it("allows no-tools only for fast and keeps text-only capability notes visible", () => {
    const view = render(
      <ModelPicker
        modelRole="main"
        providerId="openai"
        models={models}
        value="text-a"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Can use files and the shell, not the screen")).toBeTruthy();
    expect(screen.getByRole("option", { name: /Summary fixture/ }).hasAttribute("disabled")).toBe(
      true,
    );
    view.rerender(
      <ModelPicker
        modelRole="fast"
        providerId="openai"
        models={models}
        value="summary-b"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: /Summary fixture/ }).hasAttribute("disabled")).toBe(
      false,
    );
  });
  it("searches IDs without changing a saved model when its catalog disappears", () => {
    const change = vi.fn();
    const view = render(
      <ModelPicker
        modelRole="main"
        providerId="openai"
        models={models}
        value="text-a"
        onChange={change}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search main models"), {
      target: { value: "summary-b" },
    });
    expect((screen.getByRole("combobox", { name: "main model" }) as HTMLSelectElement).value).toBe(
      "text-a",
    );
    view.rerender(
      <ModelPicker
        modelRole="main"
        providerId="openai"
        models={[]}
        value="text-a"
        onChange={change}
      />,
    );
    expect((screen.getByRole("combobox", { name: "main model" }) as HTMLSelectElement).value).toBe(
      "text-a",
    );
    expect(
      screen.getByRole("option", { name: /unavailable in this catalog/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });
  it("offers an Other custom ID without inventing remote catalog entries or permitting routers", () => {
    const change = vi.fn();
    const view = render(
      <ModelPicker
        modelRole="main"
        providerId="openai-compatible"
        models={[]}
        value="custom-id"
        onChange={change}
      />,
    );
    fireEvent.change(screen.getByLabelText("main custom model ID"), {
      target: { value: "custom-next" },
    });
    expect(change).toHaveBeenCalledWith("custom-next");
    view.rerender(
      <ModelPicker
        modelRole="main"
        providerId="openrouter"
        models={[{ ...(models[0] as PickerModel), id: "openrouter/auto" }]}
        value="openrouter/auto"
        onChange={change}
      />,
    );
    expect(screen.queryByLabelText("main custom model ID")).toBeNull();
    expect(screen.getByRole("option", { name: /openrouter\/auto/ }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByText(/Choose a specific model/)).toBeTruthy();
  });
  it("retains an inherited key name after metadata refresh and marks a deleted key honestly", () => {
    const props = {
      modelRole: "main" as const,
      value: { provider: "openai", model: "text-a", key: stored.id },
      providers: [{ id: "openai", models }],
      keys: [stored],
      keyLayer: "online" as const,
      onChange: vi.fn(),
      onKeys: vi.fn(),
    };
    const view = render(<RoleEditor {...props} />);
    expect((screen.getByRole("combobox", { name: "main key" }) as HTMLSelectElement).value).toBe(
      stored.id,
    );
    view.rerender(<RoleEditor {...props} keys={[]} />);
    expect((screen.getByRole("combobox", { name: "main key" }) as HTMLSelectElement).value).toBe(
      stored.id,
    );
    expect(screen.getByRole("option", { name: /missing or bound/ }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(props.onChange).not.toHaveBeenCalled();
  });
  it("uses local routes without key fields and gives a specific nested Keys trigger", () => {
    const onKeys = vi.fn();
    const props = {
      modelRole: "main" as const,
      value: { provider: "ollama", model: "qwen:fixture" },
      providers: [],
      keys: [stored],
      keyLayer: "online" as const,
      onChange: vi.fn(),
      onKeys,
    };
    const view = render(<RoleEditor {...props} />);
    expect(screen.queryByRole("combobox", { name: "main key" })).toBeNull();
    view.rerender(<RoleEditor {...props} value={{ provider: "azure", model: "fixture" }} />);
    expect(screen.getByText("Configure the endpoint under Keys.")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Add key for main" });
    fireEvent.click(button);
    expect(onKeys).toHaveBeenCalledWith("main", "azure", button);
  });
  it("turns optional roles off explicitly, clears old provider-bound selection on a provider change and refuses local remote rows", () => {
    function Form() {
      const [value, set] = useState<RoleChoice | undefined>({
        provider: "openai",
        model: "text-a",
        key: stored.id,
      });
      return (
        <RoleEditor
          modelRole="fast"
          value={value}
          providers={[{ id: "openai", models }]}
          keys={[stored]}
          keyLayer="online"
          onChange={set}
          onKeys={vi.fn()}
        />
      );
    }
    render(<Form />);
    fireEvent.change(screen.getByRole("combobox", { name: "fast provider" }), {
      target: { value: "google" },
    });
    expect((screen.getByRole("combobox", { name: "fast model" }) as HTMLSelectElement).value).toBe(
      "",
    );
    expect((screen.getByRole("combobox", { name: "fast key" }) as HTMLSelectElement).value).toBe(
      "",
    );
    fireEvent.click(screen.getByLabelText("Use a fast model"));
    expect(screen.queryByRole("combobox", { name: "fast provider" })).toBeNull();
    cleanup();
    render(<ProviderPicker modelRole="local" value="ollama" onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: "OpenAI" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("option", { name: "ChatGPT plan" })).toBeNull();
  });
});
