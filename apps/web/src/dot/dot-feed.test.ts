import { type ActionState, emptyModel, type SessionModel } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { hudFor } from "../cells/hud-state.ts";
import type { CellSummary } from "../cells/types.ts";
import { statusFor, type TaskHud } from "../session/status.ts";
import { dotFeed, sayMs } from "./dot-feed.ts";

const cell: CellSummary = {
  id: "01JXYZ0000000000000000ABCD",
  state: "ready",
  scale: 2,
  createdAt: "",
  stream: { connection: "live", viewers: 1, lastUpstreamAt: null },
};
const live = hudFor({ cell, status: "known", pending: null });
const task = (row: TaskHud["row"], phase: TaskHud["phase"] = "running"): TaskHud => ({
  row,
  phase,
  label: "",
  caption: "",
  elapsedS: null,
  countdownS: null,
  control: phase === "running",
});
const status = (row: TaskHud["row"], phase?: TaskHud["phase"]) =>
  statusFor({ computer: live, task: task(row, phase) });

function model(action: Partial<ActionState>): SessionModel {
  const m = emptyModel();
  m.screen = { w: 2560, h: 1600, scale: 2 };
  m.actions.push({
    id: "a1",
    verb: "click",
    label: "Click F3",
    intentT: 100,
    progress: [],
    ...action,
  } as ActionState);
  return m;
}

describe("dot's feed from the status model", () => {
  it("watches the computer, rather than acting, while an action waits on it", () => {
    expect(dotFeed(status("acting"), model({ verb: "wait" }), 200).state).toBe("watching");
    expect(dotFeed(status("acting"), model({ verb: "click" }), 200).state).toBe("acting");
  });

  it("puts the amber mark on dot only when it needs the user", () => {
    expect(dotFeed(status("approval", "waiting"), null, 0).attention).toBe(true);
    expect(dotFeed(status("question", "waiting"), null, 0).attention).toBe(true);
    expect(dotFeed(status("recovery", "waiting"), null, 0).attention).toBe(true);
    expect(dotFeed(status("limit", "waiting"), null, 0).attention).toBe(true);
    expect(dotFeed(status("retrying"), null, 0).attention).toBe(false);
    expect(dotFeed(status("acting"), null, 0).attention).toBe(false);
    expect(dotFeed(status("takeover", "waiting"), null, 0).attention).toBe(false);
  });

  it("aims at the current action's point as a share of the screen", () => {
    const m = model({ target: { point: { x: 1280, y: 400 } } as ActionState["target"] });
    expect(dotFeed(status("acting"), m, 200).focus).toEqual({ x: 0.5, y: 0.25 });
    expect(dotFeed(status("acting"), m, 50).focus).toBeNull();
    expect(dotFeed(status("acting"), model({ point: { x: 640, y: 1600 } }), 200).focus).toEqual({
      x: 0.25,
      y: 1,
    });
  });

  it("nods once the action's input has gone to the computer, and celebrates a finished task", () => {
    expect(dotFeed(status("acting"), model({}), 200).dispatched).toBeNull();
    const sent = model({ dispatch: {} as ActionState["dispatch"] });
    expect(dotFeed(status("acting"), sent, 200).dispatched).toBe("a1");
    expect(dotFeed(status("done", "finished"), null, 0).done).toBe(true);
  });

  it("bobs for about as long as the line takes to say", () => {
    expect(sayMs("Done.")).toBe(500);
    expect(sayMs("Checking February's net total against revenue minus returns.")).toBe(1360);
    expect(sayMs("word ".repeat(40))).toBe(2200);
  });
});
