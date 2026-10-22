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
  const step = (tool: string | undefined, title = "", kind = "gui", more = {}): StepState => ({
    id: "s1",
    kind,
    startT: 50,
    ...(tool ? { tool, title } : {}),
    ...more,
  });

  it("follows the action in progress", () => {
    const of = (verb: ActionState["verb"], label: string) =>
      toolFor("acting", step(undefined), action(verb, label), 200);
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

  it("gives each tool a step runs its own prop", () => {
    const table: [tool: string | undefined, title: string, kind: string, prop: string | null][] = [
      ["shell", "ls -la", "shell", "terminal"],
      ["shell", "cat > app.py <<'EOF'", "shell", "terminal"],
      ["shell", "python3 - <<'PY'", "shell", "terminal"],
      ["shell", "cat notes.md 2>/dev/null || echo missing", "shell", "terminal"],
      ["shell", 'echo "== build ==" && npm run build 2>&1 | tail', "shell", "terminal"],
      ["shell", "tee notes.txt", "shell", "terminal"],
      ["files", "write src/app.ts", "file", "typing"],
      ["files", "edit scripts/build.py", "file", "typing"],
      ["files", "write notes.md", "file", "filing"],
      ["files", "read report.pdf", "file", "reading"],
      ["files", "list /home/user/Desktop", "file", "reading"],
      ["browser_navigate", "Opening bbc.co.uk", "browser", "browsing"],
      ["browser_read", "Reading page", "browser", "browsing"],
      ["switch_screen", "Switching to the web browser", "browser", "browsing"],
      ["browser_upload", "Upload 1 file", "browser", "sending"],
      ["web_search", "Searched the web for “Zelda”", "browser", "searching"],
      ["web_search", "Looked at images of “Zelda”", "browser", "searching"],
      ["web_fetch", "Read en.wikipedia.org", "browser", "browsing"],
      ["web_fetch", "Looked at a picture from upload.wikimedia.org", "browser", "inspecting"],
      ["find", "Looking for “Save”", "gui", "searching"],
      ["research", "Reading a PDF from iea.org", "browser", "browsing"],
      ["research", "Writing the report", "file", "typing"],
      ["work_context", "Checking available tools and access", "think", "inspecting"],
      ["recall", "Search earlier tasks: invoices", "think", "recalling"],
      ["people", "Look up Mum", "think", "recalling"],
      ["people", "Remember Mum on WhatsApp", "think", "remembering"],
      ["remember", "Save to USER.md", "think", "remembering"],
      ["update_plan", "Update the plan", "think", "planning"],
      ["routine", "Propose “Morning brief”", "think", "scheduling"],
      ["follow_up_at", "Schedule a follow-up", "think", "scheduling"],
      ["api_request", "Calling api.github.com", "app", "sending"],
      ["credentials", "Add a key", "ask", "needs-you"],
      ["ask_user", "Ask", "ask", "needs-you"],
      ["request_takeover", "Your turn", "ask", "needs-you"],
      ["done", "Waiting for progress", "think", "waiting"],
      ["linear__list_issues", "Linear · List issues", "app", "browsing"],
      ["github__search_code", "GitHub · Search code", "app", "browsing"],
      ["linear__create_issue", "Linear · Create issue", "app", "sending"],
      ["slack__send_message", "Slack · Send message", "app", "sending"],
      [undefined, "", "shell", "terminal"],
      [undefined, "", "file", "filing"],
      [undefined, "", "browser", "browsing"],
      [undefined, "", "app", "sending"],
      [undefined, "", "think", "thinking"],
    ];
    const seen = table.map(([tool, title, kind]) => [
      tool,
      title,
      kind,
      toolFor("acting", step(tool, title, kind), undefined, 200),
    ]);
    expect(seen).toEqual(table);
  });

  it("looks closely at the screen for an on-screen step that took no action, once it is over", () => {
    const look = step(undefined, "", "gui", { endT: 300 });
    expect(toolFor("acting", step(undefined, "", "gui"), undefined, 200)).toBeNull();
    expect(toolFor("thinking", look, undefined, 400)).toBe("inspecting");
    expect(toolFor("thinking", look, action("click", "Click A", { intentT: 120 }), 400)).toBe(
      "pointing",
    );
  });

  it("keeps a step that has just ended as dot's work for a moment, then thinks", () => {
    const read = step("files", "read notes.md", "file", { endT: 60 });
    expect(toolFor("thinking", read, undefined, 200)).toBe("reading");
    expect(toolFor("thinking", read, undefined, 700)).toBe("thinking");
    expect(toolFor("observing", read, undefined, 200)).toBe("reading");
    expect(toolFor("observing", read, undefined, 700)).toBe("looking");
    expect(toolFor("working", read, undefined, 700)).toBeNull();
  });

  it("prefers the step's own newer tool over an older action", () => {
    const old = action("click", "Click A", { step: "s0", intentT: 10 });
    expect(toolFor("acting", step("shell", "make", "shell"), old, 200)).toBe("terminal");
  });

  it("shows its sub-agents at work while it waits on them, but its own work first", () => {
    const shell = step("shell", "make", "shell");
    expect(toolFor("thinking", undefined, undefined, 200, true)).toBe("delegating");
    expect(toolFor("working", undefined, undefined, 200, true)).toBe("delegating");
    expect(toolFor("acting", shell, undefined, 200, true)).toBe("terminal");
    expect(toolFor("question", shell, undefined, 200, true)).toBe("needs-you");
    expect(toolFor("thinking", undefined, undefined, 200)).toBe("thinking");
  });

  it("takes needing the user, thinking and looking from the row, and puts tools down otherwise", () => {
    const busy = action("type", "Type");
    expect(toolFor("approval", step(undefined), busy, 200)).toBe("needs-you");
    expect(toolFor("question", undefined, undefined, 200)).toBe("needs-you");
    expect(toolFor("takeover", undefined, undefined, 200)).toBe("needs-you");
    expect(toolFor("thinking", step(undefined, "", "gui", { endT: 90 }), busy, 2000)).toBe(
      "thinking",
    );
    expect(toolFor("retrying", undefined, undefined, 200)).toBe("thinking");
    expect(toolFor("observing", step(undefined, "", "gui", { endT: 90 }), busy, 2000)).toBe(
      "looking",
    );
    for (const row of ["done", "ready", "stopped", "control", "failed"] as const)
      expect(toolFor(row, step(undefined), busy, 200)).toBeNull();
  });

  it("counts typing progress per action and output per command, up to the moment, with how it ended", () => {
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
    shell.steps.push({
      id: "s9",
      kind: "shell",
      startT: 10,
      endT: 120,
      status: "failed",
      tool: "shell",
      outputs: [20, 40, 90],
    });
    expect(dotFeed(status("acting"), shell, 50)).toMatchObject({
      tool: "terminal",
      beat: { key: "s9", n: 2 },
    });
    expect(dotFeed(status("acting"), shell, 50).beat).not.toHaveProperty("ok");
    expect(dotFeed(status("thinking"), shell, 300)).toMatchObject({
      tool: "terminal",
      beat: { key: "s9", n: 3, ok: false },
    });
  });

  it("brings out the plan when dot sets one out or gets items done, with no step of its own", () => {
    const m = emptyModel();
    const item = (text: string, status: string) => ({ id: text, text, status });
    m.steps.push({ id: "s1", kind: "shell", startT: 10, endT: 50, status: "ok", tool: "shell" });
    m.plans.push(
      { t: 100, items: [item("Find flights", "doing"), item("Book a hotel", "todo")] },
      { t: 2000, items: [item("Find flights", "done"), item("Book a hotel", "todo")] },
      { t: 2000.3, items: [item("Find flights", "done"), item("Book a hotel", "doing")] },
      { t: 4000, items: [item("Find flights", "done"), item("Book a hotel", "todo")] },
    );
    expect(dotFeed(status("thinking"), m, 300)).toMatchObject({
      tool: "planning",
      beat: { key: "plan-100", n: 0 },
    });
    expect(dotFeed(status("thinking"), m, 2100)).toMatchObject({
      tool: "planning",
      beat: { key: "plan-2000.3", n: 1 },
    });
    expect(dotFeed(status("thinking"), m, 2700).tool).toBe("thinking");
    // A change that gets nothing done brings out nothing.
    expect(dotFeed(status("thinking"), m, 4100).tool).toBe("thinking");
    // A step that started since is dot's work.
    m.steps.push({ id: "s2", kind: "shell", startT: 2050, tool: "shell" });
    expect(dotFeed(status("acting"), m, 2100).tool).toBe("terminal");
  });

  it("counts a note as written when it is saved", () => {
    const note = emptyModel();
    note.steps.push({ id: "m1", kind: "think", startT: 10, tool: "remember", title: "Save" });
    expect(dotFeed(status("acting"), note, 20)).toMatchObject({
      tool: "remembering",
      beat: { key: "m1", n: 1 },
    });
  });

  it("brings out a helper for each sub-agent at work, and lets one go with how it went", () => {
    const m = emptyModel();
    m.subagents.push(
      { runId: "r1", startT: 100, endT: 900, ok: true },
      { runId: "r2", startT: 150 },
      { runId: "r3", startT: 2000 },
    );
    expect(dotFeed(status("thinking"), m, 500)).toMatchObject({
      tool: "delegating",
      helpers: [{ id: "r1" }, { id: "r2" }],
    });
    expect(dotFeed(status("thinking"), m, 1000).helpers).toEqual([
      { id: "r1", ok: true },
      { id: "r2" },
    ]);
    expect(dotFeed(status("thinking"), m, 1800).helpers).toEqual([{ id: "r2" }]);
    expect(dotFeed(status("thinking"), emptyModel(), 1800)).toMatchObject({
      tool: "thinking",
      helpers: [],
    });
  });

  it("winces for a failed action, briefly", () => {
    const failed = model({ verb: "click", resultT: 300, ok: false });
    expect(dotFeed(status("acting"), failed, 500).failed).toBe("a1");
    expect(dotFeed(status("acting"), failed, 2000).failed).toBeNull();
    expect(dotFeed(status("acting"), model({ resultT: 300, ok: true }), 500).failed).toBeNull();
  });
});
