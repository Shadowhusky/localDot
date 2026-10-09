// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExportButton } from "./ExportButton.tsx";
import type { ExportJob, ExportJobState } from "./job.ts";

afterEach(cleanup);

function job(state: Partial<ExportJobState>): ExportJob {
  const snapshot: ExportJobState = {
    phase: "options",
    done: 0,
    total: 0,
    startedAt: null,
    file: null,
    note: null,
    context: null,
    where: null,
    ...state,
  };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: vi.fn(),
    cancel: vi.fn(),
    save: vi.fn(),
    dismiss: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
}

const ring = () => screen.getByRole("progressbar", { hidden: true, name: "Exporting" });

it("keeps Export focusable but off, and says why, where the browser cannot make video", () => {
  const onOpen = vi.fn();
  const reason = "Export needs Chrome, Edge or Safari 17 or later";
  render(
    <ExportButton ref={null} job={job({})} open={false} disabledReason={reason} onOpen={onOpen} />,
  );
  const trigger = screen.getByRole("button", { name: "Export video" });
  expect(trigger.getAttribute("aria-disabled")).toBe("true");
  expect(trigger.hasAttribute("disabled")).toBe(false);
  expect(document.getElementById(trigger.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    reason,
  );
  fireEvent.click(trigger);
  expect(onOpen).not.toHaveBeenCalled();
});

it("turns into a ring that fills while a video is made with the popover put away", () => {
  const exporting = job({ phase: "exporting", done: 30, total: 120 });
  const { rerender } = render(
    <ExportButton ref={null} job={exporting} open={false} onOpen={() => {}} />,
  );
  const trigger = screen.getByRole("button", { name: "Export video" });
  expect(trigger.hasAttribute("data-ring")).toBe(true);
  expect(ring().getAttribute("aria-valuenow")).toBe("30");
  expect(ring().getAttribute("aria-valuemax")).toBe("120");
  rerender(<ExportButton ref={null} job={exporting} open onOpen={() => {}} />);
  expect(trigger.hasAttribute("data-ring")).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});

it("holds a check once the video is ready, and opens even while the page would refuse a new one", () => {
  const onOpen = vi.fn();
  render(
    <ExportButton
      ref={null}
      job={job({ phase: "ready" })}
      open={false}
      disabledReason="The recording is still loading"
      onOpen={onOpen}
    />,
  );
  expect(ring().hasAttribute("data-complete")).toBe(true);
  const trigger = screen.getByRole("button", { name: "Export video" });
  expect(trigger.hasAttribute("aria-disabled")).toBe(false);
  fireEvent.click(trigger);
  expect(onOpen).toHaveBeenCalledOnce();
});
