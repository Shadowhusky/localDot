// @vitest-environment jsdom
import {
  type AutonomyRule,
  BALANCED_AUTONOMY,
  CAREFUL_AUTONOMY,
  DEFAULT_AUTONOMY,
  EDITABLE_ACTION_CLASSES,
} from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutonomyMatrix, GROUPS } from "./AutonomyMatrix.tsx";
import type { RulesView } from "./useRules.ts";

afterEach(cleanup);

const preset = (name: string) =>
  within(screen.getByRole("radiogroup", { name: "Start from" })).getByRole("radio", { name });

it("gives every class it can change exactly one row", () => {
  const rows = GROUPS.flatMap((group) => group.rows);
  expect([...rows].sort()).toEqual([...EDITABLE_ACTION_CLASSES].sort());
  expect(new Set(rows).size).toBe(rows.length);
});

it("shows which preset the choices match, or Custom, in one note that keeps its room", () => {
  const view = render(<AutonomyMatrix value={BALANCED_AUTONOMY} onChange={vi.fn()} />);
  const note = () => document.querySelector(".settings-preset-notes > [data-shown]")?.textContent;
  expect(preset("Balanced").getAttribute("aria-checked")).toBe("true");
  expect(preset("Careful").getAttribute("aria-checked")).toBe("false");
  expect(note()).toBe(
    "Recommended: works on its own in its computer and asks before acting as you.",
  );
  view.rerender(<AutonomyMatrix value={CAREFUL_AUTONOMY} onChange={vi.fn()} />);
  expect(preset("Balanced").getAttribute("aria-checked")).toBe("false");
  expect(preset("Careful").getAttribute("aria-checked")).toBe("true");
  expect(note()).toBe("Asks before every step except reading and browsing.");
  view.rerender(
    <AutonomyMatrix value={{ ...BALANCED_AUTONOMY, purchase: "handoff" }} onChange={vi.fn()} />,
  );
  expect(preset("Balanced").getAttribute("aria-checked")).toBe("false");
  expect(preset("Careful").getAttribute("aria-checked")).toBe("false");
  expect(note()).toBe("Custom: your own mix of choices.");
  expect(document.querySelectorAll(".settings-preset-notes > span")).toHaveLength(3);
});

it("applies a preset to every class at once", () => {
  const onChange = vi.fn();
  const view = render(<AutonomyMatrix value={BALANCED_AUTONOMY} onChange={onChange} />);
  fireEvent.click(preset("Careful"));
  expect(onChange).toHaveBeenLastCalledWith(CAREFUL_AUTONOMY);
  view.rerender(
    <AutonomyMatrix value={{ ...CAREFUL_AUTONOMY, reading: "ask" }} onChange={onChange} />,
  );
  fireEvent.click(preset("Balanced"));
  expect(onChange).toHaveBeenLastCalledWith(BALANCED_AUTONOMY);
});

it("lists the ten classes it can change, then the locked ones as plain text", () => {
  render(<AutonomyMatrix value={DEFAULT_AUTONOMY} onChange={vi.fn()} />);
  const names = screen
    .getAllByRole("radiogroup")
    .map(
      (group) => document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
    );
  expect(names).toEqual([
    "Start from",
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
  const locked = screen.getByRole("list", { name: "Always the same" });
  expect([...locked.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
    "Upload your filesAsk me",
    "Passwords, codes and card detailsI'll do it",
    "Unclear steps on signed-in sitesAsk me",
  ]);
  expect(within(locked).queryByRole("radio")).toBeNull();
  expect(
    screen.getByText(
      "Always allow can cover uploads and unclear steps for one task only. Once you sign in on its computer, commands count as unclear steps.",
    ),
  ).toBeTruthy();
});

it("hands uploads off when sending is handed off", () => {
  render(<AutonomyMatrix value={{ ...DEFAULT_AUTONOMY, send: "handoff" }} onChange={vi.fn()} />);
  const locked = screen.getByRole("list", { name: "Always the same" });
  expect(locked.querySelector("li")?.textContent).toBe("Upload your filesI'll do it, like sending");
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
  render(<AutonomyMatrix value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={view} />);
  const list = screen.getByRole("list", { name: "Always allowed" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((row) => row.querySelector(".settings-rule-text")?.textContent)).toEqual([
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
    <AutonomyMatrix value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={rules()} />,
  );
  expect(screen.getByText("Nothing yet. Use Always allow on a request to add one.")).toBeTruthy();
  const one = rule("01J00000000000000000000010");
  const removing = rules({ rules: [one], removing: one.id });
  view.rerender(<AutonomyMatrix value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={removing} />);
  const remove = screen.getByRole("button", { name: /^Remove/ });
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  expect(remove.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(remove);
  expect(removing.remove).not.toHaveBeenCalled();
  view.rerender(
    <AutonomyMatrix
      value={DEFAULT_AUTONOMY}
      onChange={vi.fn()}
      rules={rules({ rules: [one], failed: one.id })}
    />,
  );
  expect(screen.getByText("Couldn't remove this. Try again.")).toBeTruthy();
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
    <AutonomyMatrix value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={removing} />,
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
  view.rerender(<AutonomyMatrix value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={resetting} />);
  fireEvent.click(screen.getByRole("button", { name: /^Remove/ }));
  expect(resetting.remove).not.toHaveBeenCalled();
});

it("says when starting over failed", () => {
  const view = rules({
    unreadable: "Saved Always allow choices could not be read, so none are in use.",
    resetFailed: true,
  });
  render(<AutonomyMatrix value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={view} />);
  expect(screen.getByRole("alert").textContent).toContain("Couldn't start over. Try again.");
});

it("offers to start over when the saved choices cannot be read", () => {
  const view = rules({
    unreadable: "Saved Always allow choices could not be read, so none are in use.",
  });
  render(<AutonomyMatrix value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={view} />);
  expect(screen.getByText(/could not be read/)).toBeTruthy();
  expect(screen.queryByText("Nothing yet. Use Always allow on a request to add one.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  expect(view.reset).toHaveBeenCalledOnce();
});

it("offers to try again when the list could not load", () => {
  const view = rules({ phase: "error" });
  render(<AutonomyMatrix value={DEFAULT_AUTONOMY} onChange={vi.fn()} rules={view} />);
  expect(screen.getByText("Couldn't load this list.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(view.reload).toHaveBeenCalledOnce();
});
