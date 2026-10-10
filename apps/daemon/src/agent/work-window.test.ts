import { parseEvent, ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { WorkWindowFeed } from "./work-window.ts";

afterEach(() => vi.useRealTimers());
const event = (type: string, data: unknown, step = "command") =>
  parseEvent({
    v: 1,
    id: ulid(),
    seq: 1,
    t: 0,
    agent: "dot",
    type,
    data,
    step,
  });

it("coalesces redacted output, bounds it, and hides before visual work", async () => {
  vi.useFakeTimers();
  const send = vi.fn(
    async (
      _endpoint: { baseUrl: string; token: string },
      _update: import("../../../../packages/protocol/src/work-window.ts").WorkWindowUpdate,
    ) => {},
  );
  const endpoint = { baseUrl: "http://computer", token: "private" };
  const feed = new WorkWindowFeed({ target: () => endpoint, send });
  feed.event("task", event("step.start", { kind: "shell", intent: "Run checks" }));
  for (let i = 0; i < 200; i++)
    feed.event("task", event("tool.output", { stream: "stdout", chunk: "output\n".repeat(50) }));
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(650);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[1]).toMatchObject({ visible: true, title: "Run checks" });
  expect(send.mock.calls[0]?.[1].text.length).toBe(12000);
  feed.event("task", event("step.start", { kind: "gui" }, "click"));
  await vi.advanceTimersByTimeAsync(1);
  expect(send.mock.lastCall?.[1]).toMatchObject({ visible: false });
  feed.event("task", event("tool.output", { stream: "stdout", chunk: "late output" }));
  await vi.advanceTimersByTimeAsync(200);
  expect(send).toHaveBeenCalledTimes(2);
});

it("drops pending output when control or the selected computer changes", async () => {
  vi.useFakeTimers();
  const send = vi.fn(
    async (
      _endpoint: { baseUrl: string; token: string },
      _update: import("../../../../packages/protocol/src/work-window.ts").WorkWindowUpdate,
    ) => {},
  );
  let available = true;
  const feed = new WorkWindowFeed({
    target: () => (available ? { baseUrl: "http://computer", token: "private" } : undefined),
    send,
  });
  feed.event("task", event("step.start", { kind: "file" }));
  available = false;
  await vi.advanceTimersByTimeAsync(650);
  expect(send.mock.calls.every((call) => !call[1].visible)).toBe(true);
  feed.close();
});

it("keeps one window through consecutive background steps and abstract observing state", async () => {
  vi.useFakeTimers();
  const send = vi.fn(
    async (
      _endpoint: unknown,
      _update: import("../../../../packages/protocol/src/work-window.ts").WorkWindowUpdate,
    ) => {},
  );
  const feed = new WorkWindowFeed({
    target: () => ({ baseUrl: "http://browser-screen", token: "private" }),
    send,
  });
  feed.event("task", event("step.start", { kind: "shell" }, "first"));
  await vi.advanceTimersByTimeAsync(650);
  feed.event("task", event("agent.state", { state: "observing" }));
  feed.event("task", event("step.start", { kind: "file" }, "second"));
  await vi.advanceTimersByTimeAsync(650);
  expect(send.mock.calls).toHaveLength(2);
  expect(send.mock.calls.every((call) => call[1].visible)).toBe(true);
  expect(send.mock.lastCall?.[1].phase).toBe("task/first");
  await feed.hide("task");
  expect(send.mock.lastCall?.[1].visible).toBe(false);
});

it("does not flash a window when brief background work returns to the screen", async () => {
  vi.useFakeTimers();
  const send = vi.fn(async (_endpoint: unknown, _update: { visible: boolean }) => {});
  const feed = new WorkWindowFeed({
    target: () => ({ baseUrl: "http://computer", token: "private" }),
    send,
  });
  feed.event("task", event("step.start", { kind: "shell" }));
  await vi.advanceTimersByTimeAsync(300);
  feed.event("task", event("step.start", { kind: "gui" }, "click"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(send.mock.calls.every((call) => !call[1].visible)).toBe(true);
});

it("retains the transcript through search and connectors, then clears for browser interaction", async () => {
  vi.useFakeTimers();
  const send = vi.fn(
    async (
      _endpoint: unknown,
      _update: import("../../../../packages/protocol/src/work-window.ts").WorkWindowUpdate,
    ) => {},
  );
  const feed = new WorkWindowFeed({
    target: () => ({ baseUrl: "http://computer", token: "private" }),
    send,
  });
  feed.event("task", event("step.start", { kind: "shell" }, "build"));
  feed.event("task", event("tool.output", { stream: "stdout", chunk: "Build passed" }, "build"));
  await vi.advanceTimersByTimeAsync(650);
  for (const [step, kind, tool] of [
    ["search", "browser", "web_search"],
    ["fetch", "browser", "web_fetch"],
    ["connector", "app", "github_list_repos"],
    ["edit", "file", "files"],
  ]) {
    feed.event("task", event("step.start", { kind }, step));
    feed.event("task", event("tool.start", { tool, title: tool }, step));
    await vi.advanceTimersByTimeAsync(120);
  }
  expect(send).toHaveBeenCalledTimes(5);
  expect(send.mock.calls.every((call) => call[1].visible && call[1].phase === "task/build")).toBe(
    true,
  );
  expect(send.mock.lastCall?.[1].text).toContain("Build passed");
  expect(send.mock.lastCall?.[1].text).toContain("github_list_repos");
  feed.event("task", event("step.start", { kind: "browser" }, "navigate"));
  feed.event(
    "task",
    event("tool.start", { tool: "browser_navigate", title: "Open browser" }, "navigate"),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(send.mock.lastCall?.[1].visible).toBe(false);
  const count = send.mock.calls.length;
  feed.event("task", event("tool.output", { stream: "stdout", chunk: "late" }, "build"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).toHaveBeenCalledTimes(count);
});
