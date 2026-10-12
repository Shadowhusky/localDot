// @vitest-environment jsdom
import type { ApprovalCard } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalDecision, type ApprovalDecisionProps } from "./DecisionIsland.tsx";

afterEach(cleanup);

const ID = "01J00000000000000000000003";
const card: ApprovalCard = {
  approvalId: ID,
  generation: 2,
  revision: 3,
  expiresAt: Date.now() + 60_000,
  actionClass: "send",
  risk: "high",
  title: "Send this email?",
  fields: [
    ["To", "team@example.test"],
    ["Subject", "Monthly report (sample)"],
  ],
  always: [
    { scope: "task", label: "For this task" },
    { scope: "site", label: "On mail.example.test", site: "https://mail.example.test" },
  ],
};
const decision = (over: Partial<ApprovalDecisionProps> = {}) => (
  <ApprovalDecision card={card} pending={false} onDecision={vi.fn()} {...over} />
);
const button = (name: string) => screen.getByRole("button", { name });
const usable = (name: string) => button(name).getAttribute("aria-disabled") === null;
const answer = (decision: string, always?: string) => ({
  approvalId: ID,
  generation: 2,
  revision: 3,
  decision,
  ...(always ? { always } : {}),
});

it("asks in the action's own verb and moves focus to the question", () => {
  render(decision());
  const title = screen.getByRole("heading", { name: "Send this email?" });
  expect(document.activeElement).toBe(title);
  expect(usable("Send")).toBe(true);
  expect(usable("Don't send")).toBe(true);
  expect(screen.getByText("team@example.test")).toBeTruthy();
  expect(screen.getByText(/always needs your OK/)).toBeTruthy();
});

it("preserves a draft's focus and selection when an approval arrives or reconnects", () => {
  const view = render(<textarea aria-label="Message" defaultValue="Keep typing this draft" />);
  const field = screen.getByRole("textbox") as HTMLTextAreaElement;
  field.focus();
  field.setSelectionRange(5, 11);
  const show = (enabled: boolean) =>
    view.rerender(
      <>
        <textarea aria-label="Message" defaultValue="Keep typing this draft" />
        {decision({ enabled })}
      </>,
    );
  show(true);
  expect(document.activeElement).toBe(field);
  show(false);
  show(true);
  expect(document.activeElement).toBe(field);
  expect([field.selectionStart, field.selectionEnd]).toEqual([5, 11]);
  expect(field.value).toBe("Keep typing this draft");
});

it("does not refocus an approval after the user leaves it and the task reconnects", () => {
  const view = render(decision());
  const title = screen.getByRole("heading", { name: "Send this email?" });
  expect(document.activeElement).toBe(title);
  title.blur();
  view.rerender(decision({ enabled: false }));
  view.rerender(decision());
  expect(document.activeElement).toBe(document.body);
});

it.each([
  ["not enabled", { enabled: false }],
  ["pending", { pending: true }],
  ["expired", { card: { ...card, expiresAt: Date.now() - 1 } }],
])("answers nothing while %s", (_name, over) => {
  const onDecision = vi.fn();
  render(decision({ onDecision, ...over }));
  expect(usable("Send")).toBe(false);
  fireEvent.click(button("Send"));
  fireEvent.click(button("Don't send"));
  expect(onDecision).not.toHaveBeenCalled();
});

it("approves just this once unless a wider scope is chosen, and the scope is a capability", () => {
  const onDecision = vi.fn(async () => true);
  render(decision({ onDecision }));
  const scope = screen.getByRole("combobox", { name: "How long this answer lasts" });
  expect(scope.textContent).toContain("Just this once");
  fireEvent.click(scope, { detail: 1 });
  fireEvent.click(screen.getByRole("option", { name: "On mail.example.test" }));
  expect(onDecision).not.toHaveBeenCalled();
  fireEvent.click(button("Send"));
  expect(onDecision).toHaveBeenCalledExactlyOnceWith(answer("approve", "site"));
});

it("starts a step that doesn't act as you at this task", () => {
  const onDecision = vi.fn(async () => true);
  render(
    decision({
      onDecision,
      card: { ...card, actionClass: "browsing", title: "Browse websites" },
    }),
  );
  expect(screen.getByRole("heading", { name: "Open this website?" })).toBeTruthy();
  expect(screen.getByRole("combobox").textContent).toContain("For this task");
  fireEvent.click(button("Allow"));
  expect(onDecision).toHaveBeenCalledExactlyOnceWith(answer("approve", "task"));
});

it("takes Esc as the secondary and ⌘Return as the primary, never a plain Return", () => {
  const onDecision = vi.fn(async () => true);
  render(decision({ onDecision }));
  const title = screen.getByRole("heading", { name: "Send this email?" });
  fireEvent.keyDown(title, { key: "Enter" });
  expect(onDecision).not.toHaveBeenCalled();
  fireEvent.keyDown(title, { key: "Enter", metaKey: true, ctrlKey: true });
  expect(onDecision).toHaveBeenLastCalledWith(answer("approve"));
  fireEvent.keyDown(title, { key: "Escape" });
  expect(onDecision).toHaveBeenLastCalledWith(answer("deny"));
  expect(onDecision).toHaveBeenCalledTimes(2);
});

it("leaves out the scope when the card offers only this once", () => {
  render(decision({ card: { ...card, always: undefined } }));
  expect(screen.queryByRole("combobox")).toBeNull();
});
