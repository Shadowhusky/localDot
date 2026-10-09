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

describe("the composer's model chip", () => {
  it("names the main model and opens a menu of models by provider, the current one checked", () => {
    const { chip, onPeek } = setup();
    expect(chip.getAttribute("aria-label")).toBe("Model: Claude Sonnet 5.5");
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(chip);
    expect(onPeek).toHaveBeenCalled();
    const menu = screen.getByRole("menu", { name: "Model" });
    expect(
      within(menu)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-labelledby") && group.textContent),
    ).toEqual(["AnthropicClaude Sonnet 5.5", "Claude CodeClaude SonnetClaude Opus"]);
    const radios = within(menu).getAllByRole("menuitemradio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    within(menu).getByRole("menuitem", { name: "Manage models…" });
  });

  it("chooses another model, and does nothing for the one already chosen", async () => {
    const { chip, onChoose } = setup();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Claude Sonnet 5.5" }));
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(chip);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Claude Opus" }));
    });
    expect(onChoose).toHaveBeenCalledWith(groups[1]?.options[1]);
  });

  it("leads to Settings for the rest", () => {
    const { chip, onManage } = setup();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage models…" }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("says quietly that a task at work keeps its model, and holds while a choice saves", () => {
    const { chip } = setup({ working: true, next: true, name: "Claude Opus" });
    expect(chip.getAttribute("aria-label")).toBe("Model for the next task: Claude Opus");
    fireEvent.click(chip);
    expect(screen.getByRole("menu").textContent).toContain(
      "Applies from the next task. This one keeps its model.",
    );
    cleanup();
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    expect(screen.getByRole("menu").textContent).not.toContain("next task");
    cleanup();
    const saving = setup({ disabledReason: "Saving…" });
    expect(saving.chip.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(saving.chip);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
