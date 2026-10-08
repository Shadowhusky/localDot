// @vitest-environment jsdom
import { type ApprovalCard as Card, LocalDotEvent, type UploadApproval } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { emptyAgentModel } from "./model.ts";
import { projectAgentEvent } from "./reducer.ts";

afterEach(cleanup);
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("missing test value");
  return value;
}
function card(): Card & { upload: UploadApproval } {
  return {
    approvalId: "01J00000000000000000000003",
    generation: 1,
    revision: 4,
    expiresAt: Date.now() + 60000,
    actionClass: "send",
    risk: "high",
    title: "Upload files",
    fields: [["Tool", "browser_upload"]],
    upload: {
      destination: { origin: "https://receiver.test:8443", embedded: true },
      files: Array.from({ length: 10 }, (_, i) => ({
        path: `~/${"folder/".repeat(100)}报告-${i}.txt`,
        name: `报告-${i}.txt`,
        bytes: i * 1024,
        sha256: String(i).repeat(64),
      })),
    },
  };
}
it("preserves all ten complete paths and checksums through the event projection and approval portal", () => {
  const expected = card();
  const { fields, ...data } = expected;
  const event = LocalDotEvent.parse({
    v: 1,
    id: "01J00000000000000000000004",
    seq: 1,
    t: 1000,
    agent: "main",
    type: "approval.request",
    data: { ...data, kind: "send", preview: { fields } },
  });
  const projected = projectAgentEvent(emptyAgentModel(), event).approval;
  expect(projected).toEqual(expected);
  render(<ApprovalCard card={required(projected)} pending={false} onDecision={vi.fn()} />);
  const dialog = screen.getByRole("dialog");
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  expect(screen.getByText("Page receiving files · embedded frame")).toBeTruthy();
  expect(screen.getByText("https://receiver.test:8443")).toBeTruthy();
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(10);
  for (const file of expected.upload.files) {
    expect(screen.getByText(file.name)).toBeTruthy();
    expect(screen.getByText(file.path)).toBeTruthy();
    expect(screen.getByText(`SHA-256: ${file.sha256}`)).toBeTruthy();
    expect(screen.getByText(`${file.bytes.toLocaleString()} bytes`)).toBeTruthy();
  }
});
it("answers with only the immutable approval identity, not editable file metadata", () => {
  const value = card(),
    decide = vi.fn();
  render(<ApprovalCard card={value} pending={false} onDecision={decide} />);
  fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
  expect(decide).toHaveBeenCalledExactlyOnceWith({
    approvalId: value.approvalId,
    generation: 1,
    revision: 4,
    decision: "approve",
  });
});
it("renders a source path as inert text and does not turn it into links or HTML", () => {
  const value = card();
  const file = required(value.upload.files[0]);
  file.path = '~/folder/<img src=x onerror="alert(1)">/report.txt';
  render(<ApprovalCard card={value} pending={false} onDecision={vi.fn()} />);
  expect(screen.getByText(file.path)).toBeTruthy();
  expect(document.querySelector(".approval-upload img, .approval-upload a")).toBeNull();
});
it("refuses a duplicate or incomplete file preview instead of approving a partial list", () => {
  const value = card();
  value.upload.files[1] = required(value.upload.files[0]);
  render(<ApprovalCard card={value} pending={false} onDecision={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain("could not be verified");
  expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
});
