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
  it("groups plans and the plans not offered, and says why when one is chosen or searched", () => {
    const change = vi.fn();
    const view = render(<ProviderPicker modelRole="main" value="" onChange={change} />);
    const plans = screen.getByRole("group", { name: "Plans" });
    expect([...plans.querySelectorAll("option")].map((o) => [o.textContent, o.disabled])).toEqual([
      ["MiniMax Token Plan", false],
      ["Alibaba Token Plan", false],
      ["Alibaba Coding Plan", false],
    ]);
    const refused = screen.getByRole("group", { name: "Not available here" });
    expect([...refused.querySelectorAll("option")].map((o) => [o.textContent, o.disabled])).toEqual(
      [
        ["GLM Coding Plan — not available here", false],
        ["Kimi For Coding — not available here", false],
        ["Ark Coding Plan — not available here", false],
      ],
    );
    const GLM =
      "Z.ai lets this plan run only in the coding tools it lists. Use a Z.ai API key here instead.";
    expect(screen.queryByText(GLM)).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "main provider" }), {
      target: { value: "zai-coding-plan" },
    });
    expect(change).toHaveBeenCalledWith("zai-coding-plan");
    view.rerender(<ProviderPicker modelRole="main" value="zai-coding-plan" onChange={change} />);
    const select = screen.getByRole("combobox", { name: "main provider" });
    expect(screen.getByText(GLM).id).toBe(select.getAttribute("aria-describedby"));
    view.rerender(
      <ProviderPicker modelRole="main" value="alibaba-coding-plan" onChange={change} />,
    );
    expect(screen.queryByText(GLM)).toBeNull();
    expect(
      screen.getByText("Alibaba allows this plan only for tasks you start and watch."),
    ).toBeTruthy();
    view.rerender(<ProviderPicker modelRole="main" value="" onChange={change} />);
    fireEvent.change(screen.getByLabelText("Search main providers"), { target: { value: "kimi" } });
    expect(
      screen.getByText(
        "Kimi For Coding: Kimi lets this plan run only in coding tools it recognises. Use a Moonshot API key here instead.",
      ),
    ).toBeTruthy();
    cleanup();
    render(<ProviderPicker modelRole="local" value="" onChange={vi.fn()} />);
    expect(
      screen.getByRole("option", { name: "GLM Coding Plan — not available here" }),
    ).toHaveProperty("disabled", true);
  });
  it("says Claude plans can't be used here, under Anthropic, on a search and in Subscription", () => {
    const SENTENCE =
      "Claude Pro and Max plans can't be used here: Anthropic doesn't allow other apps to sign in with them. Add an Anthropic API key instead.";
    const PLAN = "Claude Pro or Max — not available here";
    const view = render(<ProviderPicker modelRole="main" value="" onChange={vi.fn()} />);
    expect(screen.queryByText(SENTENCE)).toBeNull();
    const plan = screen.getByRole("option", { name: PLAN }) as HTMLOptionElement;
    expect(plan.disabled).toBe(true);
    expect(plan.closest("optgroup")?.label).toBe("Subscription");
    view.rerender(<ProviderPicker modelRole="main" value="anthropic" onChange={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: "main provider" });
    expect(screen.getByText(SENTENCE).id).toBe(select.getAttribute("aria-describedby"));
    view.rerender(<ProviderPicker modelRole="main" value="openai" onChange={vi.fn()} />);
    expect(screen.queryByText(SENTENCE)).toBeNull();
    const search = screen.getByLabelText("Search main providers");
    for (const text of ["claude", "Claude Code", "pro", "MAX", "subscription"]) {
      fireEvent.change(search, { target: { value: text } });
      expect(screen.getAllByText(SENTENCE), text).toHaveLength(1);
      expect(screen.getByRole("option", { name: PLAN })).toBeTruthy();
    }
    fireEvent.change(search, { target: { value: "minimax" } });
    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(screen.queryByRole("option", { name: PLAN })).toBeNull();
    fireEvent.change(search, { target: { value: "claude" } });
    view.rerender(<ProviderPicker modelRole="main" value="anthropic" onChange={vi.fn()} />);
    expect(screen.getAllByText(SENTENCE)).toHaveLength(1);
    cleanup();
    render(<ProviderPicker modelRole="fast" value="anthropic" onChange={vi.fn()} />);
    expect(screen.getByText(SENTENCE)).toBeTruthy();
  });
  it("offers Anthropic on a Claude plan search, so the sentence's next step is one pick away", () => {
    for (const role of ["main", "fast"] as const) {
      const change = vi.fn();
      render(<ProviderPicker modelRole={role} value="" onChange={change} />);
      const search = screen.getByLabelText(`Search ${role} providers`);
      for (const text of ["claude", "claude code token", "pro", "gemini pro", "subscription"]) {
        fireEvent.change(search, { target: { value: text } });
        const anthropic = screen.getByRole("option", { name: "Anthropic" }) as HTMLOptionElement;
        expect(anthropic.disabled, `${role} ${text}`).toBe(false);
        expect(anthropic.closest("optgroup")?.label).toBe("API providers");
      }
      fireEvent.change(screen.getByRole("combobox", { name: `${role} provider` }), {
        target: { value: "anthropic" },
      });
      expect(change).toHaveBeenCalledWith("anthropic");
      fireEvent.change(search, { target: { value: "groq" } });
      expect(screen.queryByRole("option", { name: "Anthropic" })).toBeNull();
      cleanup();
    }
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
  it("shows only the reason for a plan that is not offered, and a plan's key and rule otherwise", () => {
    const onKeys = vi.fn();
    const props = {
      modelRole: "main" as const,
      value: { provider: "zai-coding-plan", model: "" },
      providers: [],
      keys: [{ ...stored, provider: "openai-compatible", baseURL: "https://api.minimax.io/v1" }],
      keyLayer: "online" as const,
      onChange: vi.fn(),
      onKeys,
    };
    const view = render(<RoleEditor {...props} />);
    expect(screen.getByText(/^Z\.ai lets this plan run only/)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "main model" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "main key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add key for main" })).toBeNull();
    view.rerender(
      <RoleEditor
        {...props}
        value={{ provider: "minimax-coding-plan", model: "MiniMax-M3", key: stored.id }}
        providers={[{ id: "minimax-coding-plan", models }]}
      />,
    );
    expect((screen.getByRole("combobox", { name: "main key" }) as HTMLSelectElement).value).toBe(
      stored.id,
    );
    expect(screen.getByRole("combobox", { name: "main model" })).toBeTruthy();
    const button = screen.getByRole("button", { name: "Add key for main" });
    fireEvent.click(button);
    expect(onKeys).toHaveBeenCalledWith("main", "minimax-coding-plan", button);
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
