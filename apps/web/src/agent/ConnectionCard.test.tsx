// @vitest-environment jsdom
import type { ApprovalCard as Card } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionCard } from "./ConnectionCard.tsx";

afterEach(cleanup);

const card: Card = {
  approvalId: "01J00000000000000000000009",
  generation: 1,
  revision: 3,
  expiresAt: Date.now() + 60_000,
  actionClass: "network",
  risk: "medium",
  title: "wechat wants to connect to chat.example.com:5222",
  fields: [
    ["Program", "wechat"],
    ["Destination", "chat.example.com:5222"],
  ],
  always: [
    { scope: "task", label: "For this task", destination: "chat.example.com:5222" },
    { scope: "app", label: "Always for wechat", app: "wechat" },
    {
      scope: "destination",
      label: "Always for chat.example.com:5222",
      destination: "chat.example.com:5222",
    },
  ],
};
const answer = { approvalId: card.approvalId, generation: 1, revision: 3 };

it("asks once, for the task or always, and never offers to take control", () => {
  const onDecision = vi.fn();
  render(<ConnectionCard card={card} pending={false} onDecision={onDecision} />);
  expect(screen.getByRole("heading", { name: card.title })).toBeTruthy();
  expect(screen.getByText("chat.example.com:5222")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  fireEvent.click(screen.getByRole("button", { name: "Allow for this task" }));
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  fireEvent.click(screen.getByRole("button", { name: "Always allow…" }));
  expect(screen.queryByRole("button", { name: "For this task" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Always for wechat" }));
  fireEvent.click(screen.getByRole("button", { name: "Always for chat.example.com:5222" }));
  expect(onDecision.mock.calls.map(([value]) => value)).toEqual([
    { ...answer, decision: "approve" },
    { ...answer, decision: "approve", always: "task" },
    { ...answer, decision: "deny" },
    { ...answer, decision: "approve", always: "app" },
    { ...answer, decision: "approve", always: "destination" },
  ]);
});

it.each([
  ["not enabled", { enabled: false }],
  ["pending", { pending: true }],
  ["expired", { card: { ...card, expiresAt: Date.now() - 1 } }],
])("answers nothing while %s", (_name, over) => {
  const onDecision = vi.fn();
  render(<ConnectionCard card={card} pending={false} onDecision={onDecision} {...over} />);
  for (const name of ["Allow once", "Allow for this task", "Deny"]) {
    const button = screen.getByRole("button", { name, hidden: true }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(onDecision).not.toHaveBeenCalled();
});

it("refuses a card that is not a connection's", () => {
  render(
    <ConnectionCard card={{ ...card, actionClass: "send" }} pending={false} onDecision={vi.fn()} />,
  );
  expect(screen.getByRole("alert").textContent).toContain("could not be verified");
});
