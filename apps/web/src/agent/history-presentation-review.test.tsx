// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import type { Status } from "../session/status.ts";
import { ActivityRail } from "../shell/ActivityRail.tsx";
import { HudIsland } from "../shell/HudIsland.tsx";
import { ANNOUNCE_GAP, Announcer } from "../ui/Announcer.tsx";
import { Conversation } from "./Conversation.tsx";
import type { AgentMessage } from "./model.ts";
import { threadItems } from "./thread.ts";

const api = createApi("inert-review", {
  origin: "https://owned.invalid",
  fetchImpl: async () => {
    throw new Error("Unexpected fixture network request");
  },
});
const steps = (count: number, prefix = "Reading step"): StepRowView[] =>
  Array.from({ length: count }, (_, n) => ({
    id: `step-${n}`,
    startT: n,
    label: `${prefix} ${n}`,
    status: "ok",
    durationMs: 10,
  }));
function rail(count: number, owner = "task-a", prefix = "Reading step") {
  return (
    <ActivityRail
      rows={timelineRows(steps(count, prefix), [])}
      sessionId={owner}
      scale={1}
      api={api}
    />
  );
}
function select(node: Element) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

it("preserves selected Activity text while a reader scrolls within the current history and one live step arrives", () => {
  const v = render(rail(180));
  const pane = screen
    .getByRole("complementary", { name: "Plan and steps" })
    .querySelector(".activity-scroll") as HTMLElement;
  Object.defineProperties(pane, {
    scrollHeight: { configurable: true, value: 10_000 },
    clientHeight: { configurable: true, value: 600 },
  });
  fireEvent.wheel(pane, { deltaY: -120 });
  pane.scrollTop = 100;
  fireEvent.scroll(pane);
  const selected = screen.getByText("Reading step 80");
  select(selected);
  expect(window.getSelection()?.toString()).toBe("Reading step 80");
  v.rerender(rail(181));
  expect
    .soft(
      selected.isConnected,
      "a live tail advance must not evict the reader's selected mounted row",
    )
    .toBe(true);
  expect
    .soft(
      window.getSelection()?.toString(),
      "copy selection must survive without requiring an Older action first",
    )
    .toBe("Reading step 80");
  expect(screen.getAllByTestId("step-row")).toHaveLength(101);
});

it("the earliest Activity row retains its node and selection through a live addition", () => {
  const v = render(rail(180));
  fireEvent.click(screen.getByRole("button", { name: "Earlier steps" }));
  const selected = screen.getByText("Reading step 0");
  select(selected);
  v.rerender(rail(181));
  expect(screen.getByText("Reading step 0")).toBe(selected);
  expect(window.getSelection()?.toString()).toBe("Reading step 0");
  expect(screen.getAllByTestId("step-row")).toHaveLength(181);
});

it("an Activity owner change replaces the complete list even when IDs overlap", () => {
  const v = render(rail(180));
  fireEvent.click(screen.getByRole("button", { name: "Earlier steps" }));
  expect(screen.getByText("Reading step 0")).toBeTruthy();
  v.rerender(rail(140, "task-b", "Replacement step"));
  expect(screen.queryByText("Reading step 0")).toBeNull();
  expect(screen.getAllByTestId("step-row")).toHaveLength(100);
  expect(screen.getByText("Replacement step 40")).toBeTruthy();
});

it("completed announcements are bounded, key-guarded and retired on owner replacement", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const m = (id: string, text: string, final = true): AgentMessage => ({
    id,
    text,
    final,
    role: "assistant",
  });
  const thread = (owner: string, messages: AgentMessage[]) => (
    <>
      <Announcer />
      <Conversation items={threadItems(messages)} truncated={false} ownerKey={owner} />
    </>
  );
  const v = render(thread("a", [m("one", "x".repeat(500))]));
  const live = screen.getByRole("status");
  expect(live.textContent).toBe(`dot replied: ${"x".repeat(200)}`);
  v.rerender(thread("a", [m("one", "x".repeat(500)), m("two", "streaming", false)]));
  act(() => vi.advanceTimersByTime(ANNOUNCE_GAP));
  expect(live.textContent).toBe(`dot replied: ${"x".repeat(200)}`);
  v.rerender(thread("a", [m("three", `sk-proj-${"a".repeat(156)}`)]));
  act(() => vi.advanceTimersByTime(ANNOUNCE_GAP));
  expect(live.textContent).toBe("dot replied.");
  // A reply still waiting its turn when another task takes the thread is never read out.
  v.rerender(thread("a", [m("three", `sk-proj-${"a".repeat(156)}`), m("four", "Old task's end")]));
  v.rerender(thread("b", []));
  act(() => vi.advanceTimersByTime(ANNOUNCE_GAP * 2));
  expect(live.textContent).toBe("dot replied.");
  vi.useRealTimers();
});

it("the island's live status holds only the phase, with elapsed time and Stop outside it", () => {
  const working: Status = {
    row: "working",
    computer: "live",
    label: "Working",
    caption: { speaker: "dot", text: "" },
    elapsedS: 1,
    countdownS: null,
    actions: [{ kind: "stop-task", enabled: true }],
    control: true,
    dotPose: "acting",
    attention: "working",
    title: "localDot — Working",
  };
  const props = {
    status: working,
    shape: "task" as const,
    pause: { kind: "pause" as const },
    take: { primary: false },
    onPause: vi.fn(),
    onContinue: vi.fn(),
    onStopTask: vi.fn(),
    onTake: vi.fn(),
    onComputer: { start: vi.fn(), stop: vi.fn(), resume: vi.fn(), retry: vi.fn() },
  };
  const v = render(<HudIsland {...props} />);
  const status = screen.getByRole("status");
  const stop = screen.getByRole("button", { name: /^Stop$/ });
  expect(status.textContent).toBe("Working");
  expect(status.contains(stop)).toBe(false);
  expect(status.contains(screen.getByTestId("hud-elapsed"))).toBe(false);
  v.rerender(<HudIsland {...props} status={{ ...working, elapsedS: 2 }} />);
  expect(screen.getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Working");
});
