// @vitest-environment jsdom
import type { ApprovalCard as Card } from "@localdot/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard.tsx";

afterEach(cleanup);

const card: Card = {
  approvalId: "01J00000000000000000000003",
  generation: 1,
  revision: 1,
  expiresAt: Date.now() + 60_000,
  actionClass: "send",
  risk: "high",
  title: "Send as you",
  fields: [["Target", "Send"]],
};

it.each([
  ["ready", {}, true],
  ["not enabled", { enabled: false }, false],
  ["pending", { pending: true }, false],
  ["hidden", { visible: false }, false],
  ["expired", { card: { ...card, expiresAt: Date.now() - 1 } }, false],
])("hands its own Approve condition to what it holds when %s", (_name, over, expected) => {
  const held = vi.fn((_canApprove: boolean) => <p>Held</p>);
  render(
    <ApprovalCard card={card} pending={false} onDecision={vi.fn()} {...over}>
      {held}
    </ApprovalCard>,
  );
  const approve = screen.getByRole("button", { name: "Approve once", hidden: true });
  expect((approve as HTMLButtonElement).disabled).toBe(!expected);
  expect(held).toHaveBeenLastCalledWith(expected);
  expect(screen.getByText("Held")).toBeTruthy();
});
