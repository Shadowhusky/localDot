// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AllowedNotice } from "./AllowedNotice.tsx";
import type { ApprovalOutcome } from "./model.ts";
import type { AllowedChoice } from "./useSafety.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ID = "01J00000000000000000000003";
const RULE = "01J00000000000000000000009";
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
type NoticeProps = Parameters<typeof AllowedNotice>[0];
const notice = (over: Partial<NoticeProps> = {}) => (
  <AllowedNotice
    choice={choice()}
    outcome={created()}
    visible
    onUndo={vi.fn()}
    onDismiss={vi.fn()}
    {...over}
  />
);
const said = () => screen.getByRole("status").textContent;
const undoTask = "Undo allowing sending messages for this task";
const toast = () => document.querySelector(".always-notice");

it("says what is now allowed and offers Undo", () => {
  const onUndo = vi.fn();
  render(notice({ onUndo }));
  expect(said()).toBe("Allowed for this task: sending messages.");
  expect(toast()?.textContent).toBe("Allowed for this task: sending messages.Undo");
  fireEvent.click(screen.getByRole("button", { name: undoTask }));
  expect(onUndo).toHaveBeenCalledOnce();
});

it("keeps its live region out of sight, so the line shows once, in the note", () => {
  render(notice());
  const region = document.querySelector("[aria-live=polite]");
  expect(region?.className).toBe("ui-visually-hidden");
  expect(region?.textContent).toBe("Allowed for this task: sending messages.");
});

it("announces the line through a live region that is there before it", () => {
  const view = render(notice({ choice: null }));
  const region = screen.getByRole("status");
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(region.textContent).toBe("");
  expect(toast()).toBeNull();
  view.rerender(notice());
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("Allowed for this task: sending messages.");
  view.rerender(notice({ choice: choice({ undo: "done" }) }));
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("Undone. You'll be asked again next time.");
});

it("names the site, app or always scope, and what Undo takes back", () => {
  const site = {
    scope: "site" as const,
    label: "On mail.example.test",
    site: "https://mail.example.test",
  };
  const view = render(
    notice({
      choice: choice({ option: site }),
      outcome: created({ rule: { ...site, actionClass: "send", id: RULE } }),
    }),
  );
  expect(said()).toBe("Allowed on mail.example.test: sending messages.");
  expect(
    screen.getByRole("button", { name: "Undo allowing sending messages on mail.example.test" }),
  ).toBeTruthy();
  view.rerender(
    notice({
      choice: choice({ actionClass: "computer", option: { scope: "always", label: "Always" } }),
      outcome: created({
        actionClass: "computer",
        rule: { scope: "always", label: "Always", actionClass: "computer", id: RULE },
      }),
    }),
  );
  expect(said()).toBe("Always allowed: working in its computer.");
  expect(
    screen.getByRole("button", { name: "Undo always allowing working in its computer" }),
  ).toBeTruthy();
});

it("waits for the task to confirm the choice before showing anything", () => {
  render(notice({ outcome: created({ approvalId: "01J00000000000000000000004" }) }));
  expect(toast()).toBeNull();
  expect(said()).toBe("");
});

it("shows why a choice was not saved, without Undo", () => {
  const note =
    "Approved once. Your Always allow choice was not saved. You can keep up to 200 Always allow choices.";
  render(
    notice({
      choice: choice({
        option: { scope: "site", label: "On mail.example.test", site: "https://mail.example.test" },
      }),
      outcome: { approvalId: ID, decision: "approve", actionClass: "send", note },
    }),
  );
  expect(said()).toBe(note);
  expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
});

it("confirms an undo and reports one that failed", () => {
  const view = render(notice({ choice: choice({ undo: "failed" }) }));
  expect(said()).toBe("Allowed for this task: sending messages. Couldn't undo. Try again.");
  expect(screen.getByRole("button", { name: undoTask })).toBeTruthy();
  view.rerender(notice({ choice: choice({ undo: "pending" }) }));
  expect(screen.getByRole("button", { name: undoTask }).getAttribute("aria-disabled")).toBe("true");
  view.rerender(notice({ outcome: created({ ruleRemoved: true }) }));
  expect(said()).toBe("Undone. You'll be asked again next time.");
  expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
});

it("leaves after about 8 seconds, but not while you are on it", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  render(notice({ onDismiss }));
  const undo = screen.getByRole("button", { name: undoTask });
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

it("still leaves once Undo has done its work under the pointer", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  const view = render(notice({ onDismiss }));
  const undo = screen.getByRole("button", { name: undoTask });
  fireEvent.pointerEnter(undo);
  fireEvent.focus(undo);
  view.rerender(notice({ choice: choice({ undo: "done" }), onDismiss }));
  expect(said()).toBe("Undone. You'll be asked again next time.");
  act(() => vi.advanceTimersByTime(8_500));
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("is not held by an Undo that Settings covered while it had focus", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  const view = render(notice({ onDismiss }));
  fireEvent.focus(screen.getByRole("button", { name: undoTask }));
  view.rerender(notice({ onDismiss, visible: false }));
  view.rerender(notice({ onDismiss }));
  act(() => vi.advanceTimersByTime(8_500));
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("keeps counting while Settings or Keys hides it", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  const view = render(notice({ onDismiss }));
  act(() => vi.advanceTimersByTime(5_000));
  view.rerender(notice({ onDismiss, visible: false }));
  expect(toast()).toBeNull();
  expect(said()).toBe("");
  act(() => vi.advanceTimersByTime(2_000));
  view.rerender(notice({ onDismiss }));
  expect(said()).toBe("Allowed for this task: sending messages.");
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
    notice({ outcome: { approvalId: ID, decision: "approve", actionClass: "send", ...over } }),
  );
  expect(toast()).toBeNull();
  expect(said()).toBe("");
});
