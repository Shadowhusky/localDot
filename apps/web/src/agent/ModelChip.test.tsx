// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelGroup } from "../settings/model-options.ts";
import { ModelChip } from "./ModelChip.tsx";

afterEach(cleanup);

const groups: ModelGroup[] = [
  {
    label: "Anthropic",
    options: [
      {
        id: "sonnet",
        name: "Claude Sonnet 5.5",
        choice: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
      },
    ],
  },
  {
    label: "Claude Code",
    options: [
      {
        id: "cc-sonnet",
        name: "Claude Sonnet",
        choice: { provider: "claude-code", model: "sonnet" },
      },
      { id: "cc-opus", name: "Claude Opus", choice: { provider: "claude-code", model: "opus" } },
    ],
  },
];

function setup(over: Partial<Parameters<typeof ModelChip>[0]> = {}) {
  const onChoose = vi.fn();
  const onManage = vi.fn();
  const onPeek = vi.fn();
  render(
    <ModelChip
      name="Claude Sonnet 5.5"
      groups={groups}
      current="sonnet"
      onChoose={onChoose}
      onManage={onManage}
      onPeek={onPeek}
      {...over}
    />,
  );
  return { onChoose, onManage, onPeek, chip: screen.getByRole("button", { name: /^Model/ }) };
}

describe("the composer's model configuration", () => {
  it("opens a dialog with provider groups and only supported thinking controls", () => {
    const { chip, onPeek } = setup();
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(chip);
    expect(onPeek).toHaveBeenCalled();
    const panel = screen.getByRole("dialog", { name: "Model and thinking" });
    expect(within(panel).getByRole("slider").getAttribute("aria-valuetext")).toBe(
      "Provider default",
    );
    expect(within(panel).queryByRole("combobox", { name: "Thinking budget" })).toBeNull();
    fireEvent.click(within(panel).getByRole("combobox", { name: "Model" }));
    expect(screen.getAllByRole("group").map((g) => g.textContent)).toEqual([
      "AnthropicClaude Sonnet 5.5",
      "Claude CodeClaude SonnetClaude Opus",
    ]);
  });

  it("applies model and effort together, never saving intermediate slider changes", async () => {
    const { chip, onChoose } = setup();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude Opus" }));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "3" } });
    expect(onChoose).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(onChoose).toHaveBeenCalledExactlyOnceWith({
      ...groups[1]?.options[1],
      choice: { provider: "claude-code", model: "opus", options: { reasoningEffort: "high" } },
    });
  });

  it("can reset saved options to defaults", () => {
    const { chip, onChoose } = setup({
      choice: {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        key: "anthropic",
        options: { reasoningEffort: "max" },
      },
    });
    fireEvent.click(chip);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Maximum");
    fireEvent.click(screen.getByRole("button", { name: "Reset to provider defaults" }));
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Provider default");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChoose.mock.calls[0]?.[0].choice.options).toBeUndefined();
  });

  it("discards unapplied changes on Escape and restores focus to its trigger", async () => {
    const { chip, onChoose } = setup();
    chip.focus();
    fireEvent.click(chip);
    const slider = screen.getByRole("slider");
    slider.focus();
    fireEvent.change(slider, { target: { value: "2" } });
    await act(async () => {
      fireEvent.keyDown(slider, { key: "Escape" });
    });
    expect(onChoose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(chip);
    fireEvent.click(chip);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Provider default");
  });

  it("opens model management and explains that an active task keeps its settings", () => {
    const { chip, onManage } = setup({ working: true, next: true });
    fireEvent.click(chip);
    expect(screen.getByRole("dialog").textContent).toContain("Applies from the next task");
    fireEvent.click(screen.getByRole("button", { name: "Manage models…" }));
    expect(onManage).toHaveBeenCalledOnce();
    cleanup();
    const saving = setup({ disabledReason: "Saving…" });
    fireEvent.click(saving.chip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks Fast and Ultrafast beside the effort, and offers each speed with what it costs", () => {
    const sol = {
      id: "sol",
      name: "GPT-6.1 Sol",
      choice: {
        provider: "openai",
        model: "gpt-6.1-sol",
        key: "openai",
        options: { speed: "ultrafast" as const, reasoningEffort: "max" as const },
      },
    };
    const { chip } = setup({
      name: "GPT-6.1 Sol",
      groups: [{ label: "OpenAI", options: [sol] }],
      current: "sol",
      choice: sol.choice,
    });
    expect(chip.getAttribute("aria-label")).toBe("Model: GPT-6.1 Sol, Maximum, Ultrafast");
    expect(chip.textContent).toContain("Maximum");
    const mark = chip.querySelector(".ui-speed-mark");
    expect(mark?.getAttribute("data-speed")).toBe("ultrafast");
    expect(mark?.querySelectorAll("svg")).toHaveLength(2);
    fireEvent.click(chip);
    const speed = screen.getByRole("combobox", { name: "Speed" });
    expect(speed.textContent).toContain("Ultrafast");
    fireEvent.click(speed);
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["Standard", "Fast2× the price", "Ultrafast6× the price"]);
  });
});
