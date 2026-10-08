// @vitest-environment jsdom
import {
  type AutonomyRule,
  BALANCED_AUTONOMY,
  CAREFUL_AUTONOMY,
  DEFAULT_AUTONOMY,
} from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SafetySettings } from "./SafetySettings.tsx";
import type { RulesView } from "./useRules.ts";

afterEach(cleanup);

const preset = (name: string) => screen.getByRole("button", { name });

it("shows which preset the saved choices match, or Custom", () => {
  const view = render(<SafetySettings value={BALANCED_AUTONOMY} onChange={vi.fn()} />);
  expect(preset("Balanced (recommended)").getAttribute("aria-pressed")).toBe("true");
  expect(preset("Careful").getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByText(/^Custom/)).toBeNull();
  view.rerender(<SafetySettings value={CAREFUL_AUTONOMY} onChange={vi.fn()} />);
  expect(preset("Balanced (recommended)").getAttribute("aria-pressed")).toBe("false");
  expect(preset("Careful").getAttribute("aria-pressed")).toBe("true");
  view.rerender(
    <SafetySettings value={{ ...BALANCED_AUTONOMY, purchase: "handoff" }} onChange={vi.fn()} />,
  );
  expect(preset("Balanced (recommended)").getAttribute("aria-pressed")).toBe("false");
  expect(preset("Careful").getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText(/^Custom/)).toBeTruthy();
});

it("applies a preset to every class at once", () => {
  const onChange = vi.fn();
  const view = render(<SafetySettings value={BALANCED_AUTONOMY} onChange={onChange} />);
  fireEvent.click(preset("Careful"));
  expect(onChange).toHaveBeenLastCalledWith(CAREFUL_AUTONOMY);
  view.rerender(
    <SafetySettings value={{ ...CAREFUL_AUTONOMY, reading: "ask" }} onChange={onChange} />,
  );
  fireEvent.click(preset("Balanced (recommended)"));
  expect(onChange).toHaveBeenLastCalledWith(BALANCED_AUTONOMY);
});

it("lists the ten classes it can change, then the locked ones as plain text", () => {
  render(<SafetySettings value={DEFAULT_AUTONOMY} onChange={vi.fn()} />);
  expect(
    screen.getAllByRole("combobox").map((select) => select.getAttribute("aria-label")),
  ).toEqual([
    "Read and look",
    "Browse websites",
    "Work in its computer",
    "Run downloaded programs",
    "Save to its memory",
    "Send as you",
    "Post or publish as you",
    "Delete your online data",
    "Change account settings",
    "Buy or pay",
  ]);
  const locked = screen.getByRole("list", { name: "Can't be changed here" });
  expect([...locked.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
    "Upload your filesAsk",
    "Passwords, codes and card detailsHand off",
    "Unclear steps on signed-in sitesAsk",
  ]);
  expect(within(locked).queryByRole("combobox")).toBeNull();
  expect(
    screen.getByText(
      "Always allow can cover uploads and unclear steps for one task only. Once you sign in on its computer, commands count as unclear steps.",
    ),
  ).toBeTruthy();
});

it("hands uploads off when sending is handed off", () => {
  render(<SafetySettings value={{ ...DEFAULT_AUTONOMY, send: "handoff" }} onChange={vi.fn()} />);
  const locked = screen.getByRole("list", { name: "Can't be changed here" });
  expect(locked.querySelector("li")?.textContent).toBe("Upload your filesHand off, like sending");
});

const rule = (id: string, over: Partial<AutonomyRule> = {}): AutonomyRule => ({
  id,
  behavior: "act",
  actionClass: "send",
  scope: "site",
  site: "https://mail.example.test",
  label: "On mail.example.test",
  createdAt: 1,
  createdFrom: "01J00000000000000000000003",
  ...over,
});
const rules = (over: Partial<RulesView> = {}): RulesView => ({
  phase: "ready",
  rules: [],
  unreadable: null,
  removing: null,
  failed: null,
  resetting: false,
  resetFailed: false,
  remove: vi.fn(),
  reset: vi.fn(),
  reload: vi.fn(),
  ...over,
});

it("lists Always allowed choices with Remove on each", () => {
  const view = rules({
    rules: [
      rule("01J00000000000000000000010"),
      rule("01J00000000000000000000011", {
        actionClass: "computer",
        scope: "app",
        site: undefined,
        app: "Notes",
        label: "In Notes",
      }),
    ],
  });
  render(<SafetySettings value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={view} />);
  const list = screen.getByRole("list", { name: "Always allowed" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((row) => row.querySelector(".safety-rule-text")?.textContent)).toEqual([
    "Send as youOn mail.example.test",
    "Work in its computerIn Notes",
  ]);
  fireEvent.click(within(rows[1] as HTMLElement).getByRole("button", { name: /^Remove/ }));
  expect(view.remove).toHaveBeenCalledWith("01J00000000000000000000011");
  expect(
    screen.getByRole("button", { name: "Remove Send as you: On mail.example.test" }),
  ).toBeTruthy();
});

it("says when nothing is allowed yet, and when a removal is under way or failed", () => {
  const view = render(
    <SafetySettings value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={rules()} />,
  );
  expect(screen.getByText("Nothing yet. Use Always allow on a request to add one.")).toBeTruthy();
  const one = rule("01J00000000000000000000010");
  const removing = rules({ rules: [one], removing: one.id });
  view.rerender(<SafetySettings value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={removing} />);
  const remove = screen.getByRole("button", { name: /^Remove/ });
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(remove);
  expect(removing.remove).not.toHaveBeenCalled();
  view.rerender(
    <SafetySettings
      value={DEFAULT_AUTONOMY}
      onChange={vi.fn()}
      rules={rules({ rules: [one], failed: one.id })}
    />,
  );
  expect(screen.getByText("Couldn't remove this. Try again.")).toBeTruthy();
});

it("keeps Remove usable while the rest of Settings is busy", () => {
  const view = rules({ rules: [rule("01J00000000000000000000010")] });
  render(<SafetySettings value={DEFAULT_AUTONOMY} disabled onChange={vi.fn()} rules={view} />);
  const remove = screen.getByRole("button", { name: /^Remove/ });
  expect(remove.matches(":disabled")).toBe(false);
  fireEvent.click(remove);
  expect(view.remove).toHaveBeenCalledOnce();
});

it("holds every Remove and Start over while one change runs", () => {
  const one = rule("01J00000000000000000000010"),
    two = rule("01J00000000000000000000011", { label: "On chat.example.test" });
  const removing = rules({
    rules: [one, two],
    removing: one.id,
    unreadable: "Saved Always allow choices could not be read, so none are in use.",
  });
  const view = render(
    <SafetySettings value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={removing} />,
  );
  const other = screen.getByRole("button", { name: "Remove Send as you: On chat.example.test" });
  expect(other.getAttribute("aria-disabled")).toBe("true");
  expect(other.textContent).toBe("Remove");
  fireEvent.click(other);
  const restart = screen.getByRole("button", { name: "Start over" });
  expect(restart.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(restart);
  expect(removing.remove).not.toHaveBeenCalled();
  expect(removing.reset).not.toHaveBeenCalled();
  const resetting = rules({ rules: [two], resetting: true });
  view.rerender(<SafetySettings value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={resetting} />);
  fireEvent.click(screen.getByRole("button", { name: /^Remove/ }));
  expect(resetting.remove).not.toHaveBeenCalled();
});

it("says when starting over failed", () => {
  const view = rules({
    unreadable: "Saved Always allow choices could not be read, so none are in use.",
    resetFailed: true,
  });
  render(<SafetySettings value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={view} />);
  expect(screen.getByRole("alert").textContent).toContain("Couldn't start over. Try again.");
});

it("offers to start over when the saved choices cannot be read", () => {
  const view = rules({
    unreadable: "Saved Always allow choices could not be read, so none are in use.",
  });
  render(<SafetySettings value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={view} />);
  expect(screen.getByRole("alert").textContent).toContain("could not be read");
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  expect(view.reset).toHaveBeenCalledOnce();
});

it("offers to try again when the list could not load", () => {
  const view = rules({ phase: "error" });
  render(<SafetySettings value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={view} />);
  expect(screen.getByText("Couldn't load this list.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(view.reload).toHaveBeenCalledOnce();
});
