import type { PauseSnapshot, Rect } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { hudFor } from "../cells/hud-state.ts";
import type { CellSummary } from "../cells/types.ts";
import { statusFor, type TaskHud } from "../session/status.ts";
import { targetRingBox } from "../stage/geometry.ts";
import {
  decisionTop,
  islandAttention,
  islandDecision,
  islandShape,
  islandTop,
  liftOverScrim,
  pauseSlot,
  takeReason,
  takeSlot,
} from "./island.ts";

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
  countdownS: null,
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

it("makes Take control the porcelain action when dot hands the computer over, busy as the page takes it", () => {
  const handed = statusFor({ computer: live, task: task("takeover", "waiting") });
  expect(takeSlot(handed)).toEqual({ primary: true });
  expect(takeSlot(handed, { taking: true })).toEqual({ primary: true, busy: true });
});

it("offers Take control whatever dot is doing, and says why only when it can't be had", () => {
  for (const row of ["acting", "thinking", "paused", "question"] as const)
    expect(
      takeSlot(
        statusFor({ computer: live, task: task(row, row === "acting" ? "running" : "waiting") }),
      ),
    ).toEqual({ primary: false });
  expect(takeSlot(statusFor({ computer: live, task: null }))).toEqual({ primary: false });
  const working = statusFor({ computer: live, task: task("acting") });
  expect(takeSlot(working, { blocked: "Wait a moment" })).toEqual({
    primary: false,
    reason: "Wait a moment",
  });
  expect(takeSlot(working, { taking: true })).toEqual({ primary: false, busy: true });
});

it("lets Take control answer an approval: the user does the step themselves", () => {
  const waiting = statusFor({ computer: live, task: task("approval", "waiting") });
  expect(takeSlot(waiting, { decision: "approval", blocked: "Wait" })).toEqual({ primary: false });
});

it("gives the user's control its own shape, with Hand back in Take control's place", () => {
  const yours = statusFor({ computer: live, task: task("control", "waiting") });
  expect(islandShape(yours, false)).toBe("control");
  expect(islandShape(yours, true)).toBe("hidden");
  expect(yours.actions.map((action) => action.kind)).toEqual(["stop-task"]);
  expect(yours.control).toBe(false);
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

describe("takeReason", () => {
  it("lets the user take the computer with no task at work, once it is ready", () => {
    expect(takeReason({ task: false, ready: true, pause: undefined })).toBeUndefined();
    expect(takeReason({ task: false, ready: false, pause: undefined })).toBe(
      "Wait for the computer to be ready",
    );
  });

  it("says Stop for a Pause that can't be confirmed, which never settles by itself", () => {
    expect(takeReason({ task: true, ready: false, pause: "uncertain" })).toBe(
      "Stop the task to take over",
    );
    expect(takeReason({ task: true, ready: false, pause: "pausing" })).toBe(
      "Wait for the pause to settle",
    );
    expect(takeReason({ task: true, ready: false, pause: "paused" })).toBe("Wait a moment");
    expect(takeReason({ task: true, ready: true, pause: "paused" })).toBeUndefined();
  });
});

describe("islandTop", () => {
  it("sits the island its height and a gap over the stage's top edge, so its foot never reaches the picture", () => {
    expect(islandTop(40, 8)).toBe(-48);
    expect(islandTop(32, 8)).toBe(-40);
    for (const [height, gap] of [
      [40, 8],
      [32, 8],
    ] as const)
      expect(islandTop(height, gap) + height).toBeLessThan(0);
  });
});

describe("decisionTop", () => {
  // The fixture's sign-in: the password box on a 2560 x 1600 desktop, and the decision it grows
  // into as Chrome lays it out (487 x 320, its top 2 px over the island's, which sits 40 + 8 over
  // the stage).
  const screenPx = { w: 2560, h: 1600 };
  const password = { point: { x: 1280, y: 760 }, bbox: { x: 1040, y: 732, w: 480, h: 56 } };
  const size = { w: 487, h: 320 };
  const hung = islandTop(40, 8) - 2;
  // app.css on a laptop: the column less the rail and gutters, or what the height leaves above the
  // band; the stage's top is 104 px down the page.
  const stageAt = (w: number, h: number) => {
    const width = Math.min(w - 8 - 368 - 2 * 20, (h - 104 - 8 - 112) * 1.6);
    return { w: width, h: width / 1.6, floor: h - 104 - 16 };
  };
  const overlap = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const decisionAt = (stage: { w: number }, top: number): Rect => ({
    x: (stage.w - size.w) / 2,
    y: top,
    ...size,
  });

  for (const [w, h] of [
    [1100, 800],
    [1280, 800],
  ] as const)
    it(`drops under the password's ring instead of covering it at ${w} x ${h}`, () => {
      const stage = stageAt(w, h);
      const ring = targetRingBox(password, screenPx, stage);
      expect(overlap(ring, decisionAt(stage, hung))).toBe(true);
      const top = decisionTop({ hung, size, stageW: stage.w, rings: [ring], floor: stage.floor });
      expect(overlap(ring, decisionAt(stage, top))).toBe(false);
      expect(top).toBeCloseTo(ring.y + ring.h + 12, 6);
      expect(top + size.h).toBeLessThanOrEqual(stage.floor);
    });

  it("stays hung from the top edge while no ring is under it", () => {
    const stage = stageAt(1440, 900);
    // Hung over the stage, the decision ends above the password's ring at this size.
    const pass = targetRingBox(password, screenPx, stage);
    expect(decisionTop({ hung, size, stageW: stage.w, rings: [pass], floor: stage.floor })).toBe(
      hung,
    );
    const low = targetRingBox({ point: { x: 1280, y: 1500 } }, screenPx, stage);
    const aside = targetRingBox({ point: { x: 200, y: 400 } }, screenPx, stage);
    expect(
      decisionTop({ hung, size, stageW: stage.w, rings: [low, aside], floor: stage.floor }),
    ).toBe(hung);
    expect(decisionTop({ hung, size, stageW: stage.w, rings: [], floor: stage.floor })).toBe(hung);
  });

  it("drops under every ring it would cover, as far as the page has room", () => {
    const stage = stageAt(1440, 900);
    const user = targetRingBox({ point: { x: 1280, y: 600 } }, screenPx, stage);
    const pass = targetRingBox(password, screenPx, stage);
    const top = decisionTop({ hung, size, stageW: stage.w, rings: [pass, user], floor: 1e4 });
    expect(top).toBeCloseTo(pass.y + pass.h + 12, 6);
    expect(decisionTop({ hung, size, stageW: stage.w, rings: [pass, user], floor: 500 })).toBe(
      500 - size.h,
    );
  });
});

describe("liftOverScrim", () => {
  // The task island at 1440 x 900 and at 1100 x 800, and Settings' inspector at each width.
  const island1440 = { left: 287, top: 56, right: 777, bottom: 96 };
  const island1100 = { left: 117, top: 56, right: 607, bottom: 96 };
  const inspector = (width: number) => ({
    left: width - 608,
    top: 8,
    right: width - 8,
    bottom: 792,
  });
  const activity = { left: 0, top: 238, right: 390, bottom: 900 };

  it("rises over the scrim where no sheet meets it", () => {
    expect(liftOverScrim(true, island1440, [inspector(1440)])).toBe(true);
    expect(liftOverScrim(true, { left: 8, top: 8, right: 382, bottom: 40 }, [activity])).toBe(true);
    expect(liftOverScrim(true, island1440, [])).toBe(true);
  });

  it("stays under a sheet it would cover, and stays down without a scrim", () => {
    expect(liftOverScrim(true, island1100, [inspector(1100)])).toBe(false);
    expect(liftOverScrim(false, island1440, [])).toBe(false);
  });
});
