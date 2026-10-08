// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { timelineRows } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import type { Status } from "../session/status.ts";
import { ActivityRail } from "../shell/ActivityRail.tsx";
import { Hud } from "../shell/Hud.tsx";
import { Conversation } from "./Conversation.tsx";
import type { AgentMessage } from "./model.ts";

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

it("preserves selected Activity text while a reader scrolls within the current page and one live step arrives", () => {
  const v = render(rail(180));
  const pane = screen
    .getByRole("complementary", { name: "Plan and steps" })
    .querySelector(".activity-scroll") as HTMLElement;
  Object.defineProperties(pane, {
    scrollHeight: { configurable: true, value: 10_000 },
    clientHeight: { configurable: true, value: 600 },
  });
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
  expect(screen.getAllByTestId("step-row")).toHaveLength(100);
});

it("positive control: explicitly paging Older retains Activity node and selection through a live addition", () => {
  const v = render(rail(180));
  fireEvent.click(screen.getByRole("button", { name: "Older steps" }));
  const selected = screen.getByText("Reading step 0");
  select(selected);
  v.rerender(rail(181));
  expect(screen.getByText("Reading step 0")).toBe(selected);
  expect(window.getSelection()?.toString()).toBe("Reading step 0");
  expect(screen.getAllByTestId("step-row")).toHaveLength(100);
});

it("an Activity owner change discards the previous explicit reading page even when IDs overlap", () => {
  const v = render(rail(180));
  fireEvent.click(screen.getByRole("button", { name: "Older steps" }));
  expect(screen.getByText("Reading step 0")).toBeTruthy();
  v.rerender(rail(140, "task-b", "Replacement step"));
  expect(screen.queryByText("Reading step 0")).toBeNull();
  expect(screen.getAllByTestId("step-row")).toHaveLength(100);
  expect(screen.getByText("Replacement step 40")).toBeTruthy();
});

it("completed announcements are bounded, key-guarded and retired on owner replacement", () => {
  const m = (id: string, text: string, final = true): AgentMessage => ({
    id,
    text,
    final,
    role: "assistant",
  });
  const v = render(
    <Conversation messages={[m("one", "x".repeat(500))]} truncated={false} ownerKey="a" />,
  );
  const live = screen.getByRole("status");
  expect(live.textContent).toBe(`dot replied: ${"x".repeat(200)}`);
  v.rerender(
    <Conversation
      messages={[m("one", "x".repeat(500)), m("two", "streaming", false)]}
      truncated={false}
      ownerKey="a"
    />,
  );
  expect(live.textContent).toBe(`dot replied: ${"x".repeat(200)}`);
  v.rerender(
    <Conversation
      messages={[m("three", `sk-proj-${"a".repeat(156)}`)]}
      truncated={false}
      ownerKey="a"
    />,
  );
  expect(live.textContent).toBe("dot replied.");
  v.rerender(<Conversation messages={[]} truncated={false} ownerKey="b" />);
  expect(live.textContent).toBe("");
});

it("HUD live status contains only phase while elapsed time and Stop remain outside it", () => {
  const working: Status = {
    row: "working",
    computer: "live",
    label: "Working",
    caption: { speaker: "dot", text: "" },
    elapsedS: 1,
    actions: [{ kind: "stop-task", enabled: true }],
    control: true,
    dotPose: "acting",
    attention: "working",
    title: "localDot — Working",
  };
  const props = {
    status: working,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onStopSession: vi.fn(),
    onResume: vi.fn(),
    onRetry: vi.fn(),
  };
  const v = render(<Hud {...props} />);
  const status = screen.getByRole("status");
  const stop = screen.getByRole("button", { name: /^Stop$/ });
  expect(status.textContent).toBe("Working");
  expect(status.contains(stop)).toBe(false);
  expect(status.contains(screen.getByTestId("hud-elapsed"))).toBe(false);
  v.rerender(<Hud {...props} status={{ ...working, elapsedS: 2 }} />);
  expect(screen.getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Working");
});
