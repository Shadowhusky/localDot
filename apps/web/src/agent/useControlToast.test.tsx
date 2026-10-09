// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlStatus } from "./useTaskControls.ts";

type Kit = typeof import("../ui/Toast.tsx") & typeof import("./useControlToast.ts");
let kit: Kit;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.resetModules();
  kit = { ...(await import("../ui/Toast.tsx")), ...(await import("./useControlToast.ts")) };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Island({ status, recheck }: { status: ControlStatus | null; recheck(): void }) {
  const island = useRef<HTMLDivElement>(null);
  kit.useControlToast(status, recheck);
  return (
    <div>
      <div ref={island}>Island</div>
      <kit.Toaster anchor={island} />
    </div>
  );
}
const status = (phase: ControlStatus["phase"], message: string): ControlStatus => ({
  kind: "answer",
  target: "ask-1",
  phase,
  message,
});
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
const toasts = () => screen.queryAllByRole("listitem").map((item) => item.textContent);

it("shows nothing for a control that is confirmed within a moment", () => {
  const recheck = vi.fn();
  const view = render(<Island status={status("sending", "Sending request…")} recheck={recheck} />);
  wait(150);
  view.rerender(
    <Island
      status={status("checking", "Request acknowledged. Checking task ownership…")}
      recheck={recheck}
    />,
  );
  wait(150);
  view.rerender(<Island status={null} recheck={recheck} />);
  wait(10_000);
  expect(toasts()).toEqual([]);
});

it("keeps a refused control up with a way to check the task", () => {
  const recheck = vi.fn();
  render(
    <Island
      status={status("refused", "The request was refused. Check the current task.")}
      recheck={recheck}
    />,
  );
  wait(60_000);
  expect(toasts()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Check task state" }));
  expect(recheck).toHaveBeenCalledOnce();
});
