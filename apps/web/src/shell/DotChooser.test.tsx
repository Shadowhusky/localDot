// @vitest-environment jsdom
import type { Accessory } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { autoDotReason } from "../settings/AutoDot.tsx";
import { DotChooser } from "./DotChooser.tsx";

afterEach(cleanup);

const chooser = (auto: Parameters<typeof DotChooser>[0]["auto"], accessory?: Accessory) => {
  const onChange = vi.fn();
  render(
    <DotChooser
      open
      anchor={createRef<HTMLElement>()}
      value="coder"
      accessory={accessory}
      onChange={onChange}
      auto={auto}
      onClose={vi.fn()}
    />,
  );
  return { onChange, dialog: screen.getByRole("dialog", { name: "Your dot" }) };
};

it("lists every dot with the chosen one checked, and saves a new choice", () => {
  const { onChange, dialog } = chooser({ on: false, onChange: vi.fn() });
  const choices = screen.getAllByRole("radio");
  expect(choices).toHaveLength(6);
  expect(screen.getByRole("radio", { name: "Coder" })).toHaveProperty("checked", true);
  fireEvent.click(screen.getByRole("radio", { name: "Finance" }));
  expect(onChange).toHaveBeenCalledWith("finance");
  expect(dialog.textContent).toContain("Your choice applies from the next task.");
});

it("shows each dot wearing this localDot's accessory, in place of a hat it would wear", () => {
  chooser({ on: false, onChange: vi.fn() }, "cap");
  const worn = [...document.querySelectorAll(".persona-preview")].map((preview) =>
    [...preview.querySelectorAll<HTMLElement>("[data-wear]")].map((img) => img.dataset.wear).sort(),
  );
  expect(worn).toEqual([
    ["cap"],
    ["cap", "hoodie"],
    ["cap", "mustache"],
    ["cap", "suit"],
    ["cap", "round-glasses"],
    ["cap", "scarf"],
  ]);
});

it("turns Auto on, saying what it costs, and keeps the chosen dot for when it can't pick", () => {
  const onAuto = vi.fn();
  const { dialog } = chooser({ on: false, onChange: onAuto });
  const auto = screen.getByRole("switch", { name: "Auto" });
  expect(auto).toHaveProperty("checked", false);
  expect(auto.getAttribute("aria-describedby")).toBeTruthy();
  expect(dialog.textContent).toContain(
    "Picks each new conversation's dot in the quick request that names it. A new task may wait up to 4 seconds for it.",
  );
  fireEvent.click(auto);
  expect(onAuto).toHaveBeenCalledWith(true);
  cleanup();
  const on = chooser({ on: true, onChange: vi.fn() });
  expect(screen.getByRole("switch", { name: "Auto" })).toHaveProperty("checked", true);
  expect(on.dialog.textContent).toContain(
    "When Auto can't pick in time, the dot chosen here works the task.",
  );
});

it("says why Auto can't pick on the ChatGPT plan, and keeps it off", () => {
  const reason = autoDotReason({ provider: "chatgpt", model: "gpt-6-astra" });
  expect(autoDotReason({ provider: "claude-code", model: "opus" })).toBeUndefined();
  const onAuto = vi.fn();
  const { dialog } = chooser({
    on: true,
    onChange: onAuto,
    ...(reason ? { disabledReason: reason } : {}),
  });
  const auto = screen.getByRole("switch", { name: "Auto" });
  expect(auto).toHaveProperty("checked", false);
  expect(auto.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(auto);
  expect(onAuto).not.toHaveBeenCalled();
  expect(dialog.textContent).toContain(
    "Not with the ChatGPT plan, which answers one request at a time.",
  );
  expect(dialog.textContent).toContain("Your choice applies from the next task.");
});
