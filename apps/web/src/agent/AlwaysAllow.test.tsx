// @vitest-environment jsdom
import type { ApprovalCard } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AllowedNotice, AlwaysAllow } from "./AlwaysAllow.tsx";
import type { ApprovalOutcome } from "./model.ts";
import type { AllowedChoice } from "./useSafety.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ID = "01J00000000000000000000003";
const RULE = "01J00000000000000000000009";
const card: ApprovalCard = {
  approvalId: ID,
  generation: 2,
  revision: 3,
  expiresAt: Date.now() + 60_000,
  actionClass: "send",
  risk: "high",
  title: "Send as you",
  fields: [["Target", "Send"]],
  always: [
    { scope: "task", label: "For this task" },
    { scope: "site", label: "On mail.example.test", site: "https://mail.example.test" },
  ],
};
const open = () => fireEvent.click(screen.getByRole("button", { name: "Always allow…" }));

it("lists exactly the options the card offers", () => {
  render(<AlwaysAllow card={card} enabled pending={false} onDecision={vi.fn()} />);
  const toggle = screen.getByRole("button", { name: "Always allow…" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "For this task" })).toBeNull();
  open();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const group = screen.getByRole("group", { name: /^Allow sending messages without asking/ });
  expect(toggle.getAttribute("aria-controls")).toBe(group.id);
  expect([...group.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "For this task",
    "On mail.example.test",
  ]);
});

it.each([
  ["no options", undefined],
  ["an empty list", []],
])("shows nothing for a card with %s", (_name, always) => {
  const { container } = render(
    <AlwaysAllow card={{ ...card, always }} enabled pending={false} onDecision={vi.fn()} />,
  );
  expect(container.innerHTML).toBe("");
});

it("approves with the chosen scope and nothing else", () => {
  const onDecision = vi.fn(async () => true);
  render(<AlwaysAllow card={card} enabled pending={false} onDecision={onDecision} />);
  open();
  fireEvent.click(screen.getByRole("button", { name: "On mail.example.test" }));
  expect(onDecision).toHaveBeenCalledOnce();
  expect(onDecision).toHaveBeenCalledWith({
    approvalId: ID,
    generation: 2,
    revision: 3,
    decision: "approve",
    always: "site",
  });
});

it.each([
  ["not enabled", { enabled: false }],
  ["pending", { pending: true }],
  ["hidden", { visible: false }],
  ["expired", { card: { ...card, expiresAt: Date.now() - 1 } }],
])("is disabled like the card's buttons when %s", (_name, over) => {
  const onDecision = vi.fn();
  const props = { card, enabled: true, pending: false, onDecision, ...over };
  const view = render(<AlwaysAllow {...props} />);
  const toggle = screen.getByRole("button", { name: "Always allow…" }) as HTMLButtonElement;
  expect(toggle.disabled).toBe(true);
  view.rerender(<AlwaysAllow {...props} card={card} enabled pending={false} visible />);
  open();
  view.rerender(<AlwaysAllow {...props} />);
  const option = screen.getByRole("button", { name: "For this task" }) as HTMLButtonElement;
  expect(option.disabled).toBe(true);
  fireEvent.click(option);
  expect(onDecision).not.toHaveBeenCalled();
});

it("closes with Escape and returns focus to its button", () => {
  render(<AlwaysAllow card={card} enabled pending={false} onDecision={vi.fn()} />);
  open();
  const option = screen.getByRole("button", { name: "For this task" });
  option.focus();
  fireEvent.keyDown(option, { key: "Escape" });
  const toggle = screen.getByRole("button", { name: "Always allow…" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(toggle);
});

const choice = (over: Partial<AllowedChoice> = {}): AllowedChoice => ({
  session: "01J00000000000000000000002",
  approvalId: ID,
  actionClass: "send",
  option: { scope: "task", label: "For this task" },
  undo: "idle",
  ...over,
});
const created = (over: Partial<ApprovalOutcome> = {}): ApprovalOutcome => ({
  approvalId: ID,
  decision: "approve",
  actionClass: "send",
  rule: { scope: "task", label: "For this task", actionClass: "send" },
  ...over,
});

it("says what is now allowed and offers Undo", () => {
  const onUndo = vi.fn();
  render(
    <AllowedNotice choice={choice()} outcome={created()} onUndo={onUndo} onDismiss={vi.fn()} />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Allowed for this task: sending messages.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(onUndo).toHaveBeenCalledOnce();
});

it("names the site, app or always scope", () => {
  const view = render(
    <AllowedNotice
      choice={choice({
        option: { scope: "site", label: "On mail.example.test", site: "https://mail.example.test" },
      })}
      outcome={created({
        rule: {
          scope: "site",
          label: "On mail.example.test",
          site: "https://mail.example.test",
          actionClass: "send",
          id: RULE,
        },
      })}
      onUndo={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Allowed on mail.example.test: sending messages.",
  );
  view.rerender(
    <AllowedNotice
      choice={choice({ actionClass: "computer", option: { scope: "always", label: "Always" } })}
      outcome={created({
        actionClass: "computer",
        rule: { scope: "always", label: "Always", actionClass: "computer", id: RULE },
      })}
      onUndo={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Always allowed: working in its computer.",
  );
});

it("waits for the task to confirm the choice before showing anything", () => {
  const { container } = render(
    <AllowedNotice
      choice={choice()}
      outcome={created({ approvalId: "01J00000000000000000000004" })}
      onUndo={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  expect(container.ownerDocument.querySelector(".always-notice")).toBeNull();
});

it("shows why a choice was not saved, without Undo", () => {
  const note =
    "Approved once. Your Always allow choice was not saved. You can keep up to 200 Always allow choices.";
  render(
    <AllowedNotice
      choice={choice({
        option: { scope: "site", label: "On mail.example.test", site: "https://mail.example.test" },
      })}
      outcome={{ approvalId: ID, decision: "approve", actionClass: "send", note }}
      onUndo={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(note);
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

it("confirms an undo and reports one that failed", () => {
  const view = render(
    <AllowedNotice
      choice={choice({ undo: "failed" })}
      outcome={created()}
      onUndo={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Couldn't undo. Try again.");
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  view.rerender(
    <AllowedNotice
      choice={choice({ undo: "pending" })}
      outcome={created()}
      onUndo={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(
    <AllowedNotice
      choice={choice()}
      outcome={created({ ruleRemoved: true })}
      onUndo={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe("Undone. You'll be asked again next time.");
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

it("leaves after about 8 seconds, but not while you are on it", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  render(
    <AllowedNotice choice={choice()} outcome={created()} onUndo={vi.fn()} onDismiss={onDismiss} />,
  );
  const undo = screen.getByRole("button", { name: "Undo" });
  fireEvent.pointerEnter(undo);
  act(() => vi.advanceTimersByTime(20_000));
  expect(onDismiss).not.toHaveBeenCalled();
  fireEvent.pointerLeave(undo);
  fireEvent.focus(undo);
  act(() => vi.advanceTimersByTime(20_000));
  expect(onDismiss).not.toHaveBeenCalled();
  fireEvent.blur(undo);
  act(() => vi.advanceTimersByTime(7_000));
  expect(onDismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1_500));
  expect(onDismiss).toHaveBeenCalledOnce();
});

it.each([
  ["the card was cancelled", { decision: "deny" as const, note: "Approval cancelled." }],
  ["it was approved once elsewhere", {}],
  [
    "a different choice was saved",
    { rule: { scope: "site" as const, label: "On a.example.test", actionClass: "send" as const } },
  ],
])("shows nothing when %s", (_name, over) => {
  render(
    <AllowedNotice
      choice={choice()}
      outcome={{ approvalId: ID, decision: "approve", actionClass: "send", ...over }}
      onUndo={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
  expect(document.querySelector(".always-notice")).toBeNull();
});
