import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import {
  type ActionState,
  emptyModel,
  foldEvents,
  type SessionModel,
  type StepState,
} from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { hudFor } from "../cells/hud-state.ts";
import type { CellSummary } from "../cells/types.ts";
import { STATE_CAPTIONS, statusFor, type TaskHud, taskHud } from "../session/status.ts";
import { dotFeed, recordedPresence, sayMs, toolFor } from "./dot-feed.ts";

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

describe("dot in a recording", () => {
  let seq = 0;
  const ev = (type: string, tMs: number, data: object, step?: string) =>
    ({
      v: 1,
      id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      seq: seq++,
      t: msToMicros(tMs),
      agent: "main",
      ...(step ? { step } : {}),
      type,
      data,
    }) as LocalDotEvent;
  const recorded = foldEvents(emptyModel(), [
    ev("session.start", 0, { screen: { w: 1280, h: 800, scale: 1 }, os: "linux" }),
    ev("message.user", 0, {
      messageId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P1A",
      text: "Text Mum",
      kind: "task",
    }),
    ev("agent.state", 100, { state: "acting" }),
    ev("step.start", 100, { kind: "gui", intent: "Opening Telegram to send your message" }, "s1"),
    ev("action.intent", 110, { verb: "click", label: "Click “Telegram”", risk: "none" }, "s1"),
    ev("action.result", 500, { ok: true }, "s1"),
    ev("step.end", 550, { status: "ok" }, "s1"),
    ev("agent.state", 600, { state: "thinking" }),
    ev("session.end", 3000, { reason: "done" }),
  ]);

  it("says what dot is doing, as Replay's band does, never a word for its state", () => {
    expect(STATE_CAPTIONS.has(taskHud(recorded, 2000).caption)).toBe(true);
    for (const t of [300, 2000])
      expect(recordedPresence(recorded, t)).toMatchObject({
        line: "Opening Telegram to send your message",
        forUser: false,
      });
  });

  it("marks the end's line as one for the user", () => {
    const end = recordedPresence(recorded, 3000);
    expect(end.line).toBe(taskHud(recorded, 3000).caption);
    expect(end.forUser).toBe(true);
  });
});

describe("the tool dot works with", () => {
  const action = (verb: ActionState["verb"], label: string, more: Partial<ActionState> = {}) =>
    ({ id: "a1", step: "s1", verb, label, intentT: 100, progress: [], ...more }) as ActionState;
  const step = (tool: string | undefined, title = "", kind = "gui"): StepState => ({
    id: "s1",
    kind,
    startT: 50,
    ...(tool ? { tool, title } : {}),
  });

  it("follows the action in progress", () => {
    const of = (verb: ActionState["verb"], label: string) =>
      toolFor("acting", step(undefined), action(verb, label));
    expect(of("type", "Type “london”")).toBe("typing");
    expect(of("key", "Press Enter")).toBe("typing");
    expect(of("key", "Press Ctrl+S")).toBe("filing");
    expect(of("click", "Click “Telegram”")).toBe("pointing");
    expect(of("move", "Move to (20, 40)")).toBe("pointing");
    expect(of("click", "Click “Send”")).toBe("sending");
    expect(of("click", "Click “Post reply”")).toBe("sending");
    expect(of("drag", "Drag to (300, 200)")).toBe("dragging");
    expect(of("scroll", "Scroll down")).toBe("browsing");
    expect(of("wait", "Wait")).toBe("waiting");
  });

  it("follows the tool a step runs when it has no action of its own", () => {
    const of = (tool: string, title = "", kind = "gui") =>
      toolFor("acting", step(tool, title, kind), undefined);
    expect(of("shell", "ls -la", "shell")).toBe("terminal");
    expect(of("shell", "cat > app.py <<'EOF'", "shell")).toBe("typing");
    expect(of("shell", "tee notes.txt", "shell")).toBe("typing");
    expect(of("files", "write src/app.ts", "file")).toBe("typing");
    expect(of("files", "write notes.md", "file")).toBe("filing");
    expect(of("files", "read report.pdf", "file")).toBe("looking");
    expect(of("browser_navigate", "Opening bbc.co.uk", "browser")).toBe("browsing");
    expect(of("browser_read", "Reading page", "browser")).toBe("browsing");
    expect(of("browser_upload", "Uploading photo.jpg", "browser")).toBe("sending");
    expect(of("find", "Looking for “Save”")).toBe("looking");
    expect(of("recall", "Recall", "think")).toBe("recalling");
    expect(of("research", "Reading a PDF from iea.org", "browser")).toBe("browsing");
    expect(of("research", "Writing the report", "file")).toBe("typing");
    expect(of("people", "Look up Mum", "think")).toBe("recalling");
    expect(of("ask_user", "Ask", "ask")).toBe("needs-you");
    expect(toolFor("acting", step(undefined, "", "shell"), undefined)).toBe("terminal");
  });

  it("prefers the step's own newer tool over an older action", () => {
    const old = action("click", "Click A", { step: "s0", intentT: 10 });
    expect(toolFor("acting", step("shell", "make", "shell"), old)).toBe("terminal");
  });

  it("takes needing the user, thinking and looking from the row, and puts tools down otherwise", () => {
    const busy = action("type", "Type");
    expect(toolFor("approval", step(undefined), busy)).toBe("needs-you");
    expect(toolFor("question", undefined, undefined)).toBe("needs-you");
    expect(toolFor("takeover", undefined, undefined)).toBe("needs-you");
    expect(toolFor("thinking", step(undefined), busy)).toBe("thinking");
    expect(toolFor("retrying", undefined, undefined)).toBe("thinking");
    expect(toolFor("observing", step(undefined), busy)).toBe("looking");
    for (const row of ["done", "ready", "stopped", "control", "failed"] as const)
      expect(toolFor(row, step(undefined), busy)).toBeNull();
  });

  it("counts typing progress per action and output per command, up to the moment", () => {
    const m = model({
      id: "a1",
      verb: "type",
      label: "Type",
      progress: [
        { t: 150, count: 3, masked: false },
        { t: 300, count: 9, masked: true },
      ],
    });
    expect(dotFeed(status("acting"), m, 200).beat).toEqual({ key: "a1", n: 3 });
    expect(dotFeed(status("acting"), m, 400).beat).toEqual({ key: "a1", n: 9 });
    const shell = emptyModel();
    shell.steps.push({ id: "s9", kind: "shell", startT: 10, tool: "shell", outputs: [20, 40, 90] });
    expect(dotFeed(status("acting"), shell, 50)).toMatchObject({
      tool: "terminal",
      beat: { key: "s9", n: 2 },
    });
  });

  it("winces for a failed action, briefly", () => {
    const failed = model({ verb: "click", resultT: 300, ok: false });
    expect(dotFeed(status("acting"), failed, 500).failed).toBe("a1");
    expect(dotFeed(status("acting"), failed, 2000).failed).toBeNull();
    expect(dotFeed(status("acting"), model({ resultT: 300, ok: true }), 500).failed).toBeNull();
  });
});
