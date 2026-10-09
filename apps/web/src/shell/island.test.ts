import type { PauseSnapshot } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { hudFor } from "../cells/hud-state.ts";
import type { CellSummary } from "../cells/types.ts";
import { statusFor, type TaskHud } from "../session/status.ts";
import { islandAttention, islandDecision, islandShape, pauseSlot, takeSlot } from "./island.ts";

const cell: CellSummary = {
  id: "01JXYZ0000000000000000ABCD",
  state: "ready",
  scale: 2,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: null },
};
const computer = (summary: Partial<CellSummary> | null) =>
  hudFor({ cell: summary && { ...cell, ...summary }, status: "known", pending: null });
const live = computer({});
const task = (row: TaskHud["row"], phase: TaskHud["phase"] = "running"): TaskHud => ({
  row,
  phase,
  label: "Selecting February's net total",
  caption: "",
  elapsedS: 42,
  control: phase === "running",
});

describe("islandShape", () => {
  it("keeps one shape for a task whether dot thinks, acts, checks the screen or waits", () => {
    for (const row of ["thinking", "acting", "observing", "working", "pausing"] as const)
      expect(islandShape(statusFor({ computer: live, task: task(row) }), false)).toBe("task");
    for (const row of ["approval", "question", "takeover", "paused", "recovery"] as const)
      expect(islandShape(statusFor({ computer: live, task: task(row, "waiting") }), false)).toBe(
        "task",
      );
    expect(
      islandShape(statusFor({ computer: live, task: task("acting"), stop: "stopping" }), false),
    ).toBe("task");
  });

  it("is Ready on a live computer with no task, or once the task is over", () => {
    expect(islandShape(statusFor({ computer: live, task: null }), false)).toBe("ready");
    expect(islandShape(statusFor({ computer: live, task: task("done", "finished") }), false)).toBe(
      "ready",
    );
    const late = computer({ stream: { connection: "stalled", viewers: 1, lastUpstreamAt: null } });
    expect(islandShape(statusFor({ computer: late, task: null }), false)).toBe("ready");
  });

  it("carries the computer's own action while it is off, starting, paused or failed", () => {
    for (const summary of [
      null,
      { state: "starting" as const },
      { state: "stopped" as const },
      { paused: true as const },
      { state: "failed" as const, error: "not ready after 120 s" },
    ])
      expect(islandShape(statusFor({ computer: computer(summary), task: null }), false)).toBe(
        "computer",
      );
  });

  it("hides under the curtain and while nothing is known yet", () => {
    expect(islandShape(statusFor({ computer: live, task: task("acting") }), true)).toBe("hidden");
    const checking = hudFor({ cell: null, status: "listing", pending: "list" });
    expect(islandShape(statusFor({ computer: checking, task: null }), false)).toBe("hidden");
  });
});

it("marks with the amber point only what needs the user", () => {
  expect(islandAttention(statusFor({ computer: live, task: task("approval", "waiting") }))).toBe(
    true,
  );
  expect(islandAttention(statusFor({ computer: live, task: task("takeover", "waiting") }))).toBe(
    true,
  );
  expect(islandAttention(statusFor({ computer: live, task: task("acting") }))).toBe(false);
  expect(islandAttention(statusFor({ computer: live, task: null }))).toBe(false);
});

const pause = (phase: PauseSnapshot["phase"]): PauseSnapshot => ({
  requestId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
  revision: 1,
  phase,
  reason: "user",
  atStepBoundary: phase === "paused",
  resumeAvailable: phase === "paused",
});

describe("pauseSlot", () => {
  const base = { canPause: false, canResume: false, handedOver: false };
  it("offers Pause while dot works and keeps it in place, with a reason, when it can't", () => {
    expect(pauseSlot({ ...base, pause: null, canPause: true })).toEqual({ kind: "pause" });
    expect(pauseSlot({ ...base, pause: null }).reason).toBeTruthy();
    expect(pauseSlot({ ...base, pause: null, handedOver: true })).toEqual({
      kind: "pause",
      reason: "You have the computer",
    });
    expect(pauseSlot({ ...base, pause: pause("pausing") })).toEqual({
      kind: "pause",
      reason: "Pausing after this step",
    });
  });

  it("turns into Continue once paused", () => {
    expect(pauseSlot({ ...base, pause: pause("paused"), canResume: true })).toEqual({
      kind: "continue",
    });
    expect(pauseSlot({ ...base, pause: pause("paused"), budgetHeld: true })).toEqual({
      kind: "continue",
      reason: "Raise this task's limit first",
    });
    expect(pauseSlot({ ...base, pause: pause("resuming") }).kind).toBe("continue");
    expect(pauseSlot({ ...base, pause: pause("uncertain") }).reason).toMatch(/Stop/);
  });
});

it("makes Take control the porcelain action when dot hands the computer over", () => {
  expect(takeSlot(statusFor({ computer: live, task: task("takeover", "waiting") }))).toEqual({
    primary: true,
  });
  const working = takeSlot(statusFor({ computer: live, task: task("acting") }));
  expect(working.primary).toBe(false);
  expect(working.reason).toBeTruthy();
});

it("lets Take control answer an approval: the user does the step themselves", () => {
  const waiting = statusFor({ computer: live, task: task("approval", "waiting") });
  expect(takeSlot(waiting, "approval")).toEqual({ primary: false });
  expect(takeSlot(waiting).reason).toBeTruthy();
});

describe("islandDecision", () => {
  const base = { shape: "task" as const, approval: false, question: false, chatShown: true };
  it("grows an approval out of the island wherever the chat is", () => {
    expect(islandDecision({ ...base, approval: true })).toBe("approval");
    expect(islandDecision({ ...base, approval: true, question: true, chatShown: false })).toBe(
      "approval",
    );
  });

  it("grows a question only while the chat that holds it is out of sight", () => {
    expect(islandDecision({ ...base, question: true })).toBeNull();
    expect(islandDecision({ ...base, question: true, chatShown: false })).toBe("question");
  });

  it("keeps the island closed without a task", () => {
    for (const shape of ["hidden", "ready", "computer"] as const)
      expect(islandDecision({ ...base, shape, approval: true, chatShown: false })).toBeNull();
    expect(islandDecision(base)).toBeNull();
  });
});
