// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PickerKey, PickerModel, RoleChoice } from "./choices.ts";
import { RoleCard, type RoleCardProps } from "./RoleCard.tsx";

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
];
const stored: PickerKey = { id: "inherited-key", kind: "llm", provider: "openai" };
const base = (): RoleCardProps => ({
  modelRole: "main",
  value: { provider: "openai", model: "text-a", key: stored.id },
  providers: [{ id: "openai", models }],
  keys: [stored],
  keyLayer: "online",
  onChange: vi.fn(),
  onKeys: vi.fn(),
});
const card = (name: string) => screen.getByRole("region", { name });
const combo = (scope: HTMLElement, name: string) => within(scope).getByRole("combobox", { name });

describe("role card", () => {
  it("shows the model's capability and keeps a key that was deleted, marked as missing", () => {
    const props = base();
    const view = render(<RoleCard {...props} />);
    const main = card("Main model");
    expect(within(main).getByText("Tools")).toBeTruthy();
    expect(within(main).getByText(/Can use files and the shell, not the screen\./)).toBeTruthy();
    expect(combo(main, "Key").textContent).toBe("inherited-key");
    view.rerender(<RoleCard {...props} keys={[]} />);
    fireEvent.keyDown(combo(main, "Key"), { key: "ArrowDown" });
    const missing = screen.getByRole("option", { name: /inherited-key/ });
    expect(missing.getAttribute("aria-disabled")).toBe("true");
    expect(missing.textContent).toContain("Missing, or bound to another provider");
    expect(props.onChange).not.toHaveBeenCalled();
  });
  it("asks no key for a local server and opens Keys for this role and provider", () => {
    const props = { ...base(), value: { provider: "ollama", model: "qwen:fixture" } };
    const view = render(<RoleCard {...props} />);
    expect(within(card("Main model")).queryByRole("combobox", { name: "Key" })).toBeNull();
    view.rerender(<RoleCard {...props} value={{ provider: "azure", model: "fixture" }} />);
    expect(screen.getByText(/The endpoint's address is set with the key\./)).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add key" });
    fireEvent.click(add);
    expect(props.onKeys).toHaveBeenCalledWith("main", "azure", add);
  });
  it("says why a key can't be chosen while keys can't be read", () => {
    render(<RoleCard {...base()} keyLayer="offline" />);
    const key = combo(card("Main model"), "Key");
    expect(key.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("Keys can't be read right now. Reconnect, then choose one."),
    ).toBeTruthy();
  });
  it("offers to add a key from the Key row's list, and as a button while there is none", () => {
    const props = base();
    const view = render(<RoleCard {...props} />);
    const key = combo(card("Main model"), "Key");
    fireEvent.keyDown(key, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Add a key…" }));
    expect(props.onKeys).toHaveBeenCalledWith("main", "openai", key);
    expect(props.onChange).not.toHaveBeenCalled();
    view.rerender(
      <RoleCard {...props} value={{ provider: "openai", model: "text-a" }} keys={[]} />,
    );
    expect(screen.queryByRole("combobox", { name: "Key" })).toBeNull();
    expect(screen.getByText("No keys for OpenAI yet. Add one.")).toBeTruthy();
    view.rerender(
      <RoleCard
        {...props}
        value={{ provider: "openai", model: "text-a" }}
        keys={[]}
        keyLayer="offline"
      />,
    );
    expect(screen.getByRole("button", { name: "Add key" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });
  it("shows only the reason for a plan that isn't offered here", () => {
    render(<RoleCard {...base()} value={{ provider: "kimi-code-plan-global", model: "" }} />);
    const main = card("Main model");
    expect(within(main).getByText(/Kimi lets this plan run only in coding tools/)).toBeTruthy();
    expect(within(main).queryByRole("combobox", { name: "Model" })).toBeNull();
    expect(within(main).queryByRole("combobox", { name: "Key" })).toBeNull();
  });
  it("gives the pickers the role's notes as their description", () => {
    const view = render(
      <RoleCard {...base()} value={{ provider: "kimi-code-plan-global", model: "" }} />,
    );
    const described = (picker: HTMLElement) =>
      (picker.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    expect(described(combo(card("Main model"), "Provider"))).toMatch(
      /Kimi lets this plan run only in coding tools/,
    );
    view.rerender(<RoleCard {...base()} />);
    expect(described(combo(card("Main model"), "Model"))).toMatch(
      /Can use files and the shell, not the screen\./,
    );
  });
  it("lets a custom endpoint take a typed model ID, say whether it sees images, its context and a flat-rate plan", () => {
    const changes: RoleChoice[] = [];
    function Form() {
      const [value, set] = useState<RoleChoice | undefined>({
        provider: "anthropic-compatible",
        model: "",
        key: "anc",
      });
      return (
        <RoleCard
          {...base()}
          value={value}
          providers={[]}
          keys={[{ id: "anc", kind: "llm", provider: "anthropic-compatible" }]}
          onChange={(next) => {
            if (next) changes.push(next);
            set(next);
          }}
        />
      );
    }
    render(<Form />);
    fireEvent.change(screen.getByRole("textbox", { name: "Model ID" }), {
      target: { value: "glm-fixture" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Can see images" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Context window" }), {
      target: { value: "64k000" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Flat-rate plan" }));
    expect(changes.at(-1)).toEqual({
      provider: "anthropic-compatible",
      model: "glm-fixture",
      key: "anc",
      vision: false,
      contextTokens: 64000,
      plan: true,
    });
    expect(screen.getByText("Uses the plan's limits, not a spending limit.")).toBeTruthy();
  });
  it("turns an optional role on and off, and a new provider clears the old model and key", () => {
    const onChange = vi.fn();
    const view = render(
      <RoleCard {...base()} modelRole="fast" value={undefined} onChange={onChange} />,
    );
    const fast = screen.getByRole("switch", { name: "Fast model" });
    fireEvent.click(fast);
    expect(onChange).toHaveBeenLastCalledWith({ provider: "", model: "" });
    view.rerender(
      <RoleCard
        {...base()}
        modelRole="fast"
        onChange={onChange}
        value={{ provider: "openai", model: "text-a", key: "k" }}
      />,
    );
    const provider = combo(card("Fast model"), "Provider");
    fireEvent.keyDown(provider, { key: "ArrowDown" });
    const search = screen.getByRole("combobox", { name: "Search: Provider" });
    fireEvent.change(search, { target: { value: "groq" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({ provider: "groq", model: "" });
    fireEvent.click(screen.getByRole("switch", { name: "Fast model" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
  it("keeps an optional role's choice but turns it off while the main model uses the ChatGPT plan", () => {
    render(
      <RoleCard
        {...base()}
        modelRole="local"
        inactive="Off while the main model uses the ChatGPT plan."
        value={{ provider: "ollama", model: "q" }}
      />,
    );
    const local = screen.getByRole("switch", { name: "Local model" });
    expect((local as HTMLInputElement).checked).toBe(false);
    expect(local.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Off while the main model uses the ChatGPT plan.")).toBeTruthy();
  });
});
