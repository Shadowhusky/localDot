import { LocalDotEvent } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { timelineRows } from "../session/key-uses.ts";
import { stepRows } from "../session/session-view.ts";
import { activityRows, stepStatus } from "./activity.ts";
import { emptyAgentModel } from "./model.ts";
import { createAgentFeed, projectAgentEvent } from "./reducer.ts";

const id = (n: number) => String(n).padStart(26, "0");
const event = (seq: number, type: string, data: unknown, step?: string) =>
  LocalDotEvent.parse({
    v: 1,
    id: id(seq),
    seq,
    t: seq * 1000,
    agent: "main",
    type,
    data,
    ...(step ? { step } : {}),
  });
const key = {
  secretId: "sample",
  host: "example.test",
  method: "GET",
  path: "/sample",
  decision: "allow",
};

describe("ordered activity presentation", () => {
  it("joins GUI steps once and splits identical key uses around an intervening tool", () => {
    const events = [
      event(0, "step.start", { kind: "gui" }, "gui"),
      event(1, "action.intent", { verb: "click", label: "Click Save", risk: "none" }, "gui"),
      event(2, "key.use", key),
      event(3, "tool.start", { tool: "run", title: "Read report" }, "shell"),
      event(4, "key.use", key),
      event(5, "step.start", { kind: "file" }, "file"),
      event(6, "file.change", { path: "report.txt", op: "create", patch: "+sample" }, "file"),
      event(7, "step.start", { kind: "browser" }, "browser"),
      event(8, "step.start", { kind: "ask" }, "ask"),
    ];
    const legacy = foldEvents(emptyModel(), events),
      model = events.reduce(projectAgentEvent, emptyAgentModel());
    const rows = activityRows(
      timelineRows(stepRows(legacy), legacy.keyUses),
      model,
      legacy.keyUses,
    );
    expect(rows.map((row) => (row.kind === "key" ? `key:${row.count}` : row.id))).toEqual([
      "gui",
      "key:1",
      "shell",
      "key:1",
      "file",
      "browser",
      "ask",
    ]);
    expect(model.steps.get("shell")?.firstSeenAt).toBe(3000);
    expect(model.changes[0]?.step).toBe("file");
  });
  it("does not apply an out-of-order packet until ordered replay, then retains distinct outcomes", () => {
    const feed = createAgentFeed();
    feed.reset(id(100), id(101));
    feed.connection("live");
    const events = [
      event(0, "step.start", { kind: "shell" }, "cmd"),
      event(1, "tool.start", { tool: "run", title: "Failing command" }, "cmd"),
      event(2, "tool.end", { ok: false, exitCode: 7 }, "cmd"),
      event(3, "step.end", { status: "blocked", note: "Permission was refused." }, "cmd"),
    ];
    feed.accept(JSON.stringify(events[2]));
    expect(feed.read().model.steps.size).toBe(0);
    for (const e of events) feed.accept(JSON.stringify(e));
    feed.accept(JSON.stringify(events[1]));
    const step = feed.read().model.steps.get("cmd");
    expect(step).toBeDefined();
    expect(step && stepStatus(step, false)).toBe("Blocked");
    expect(step?.tool?.ok).toBe(false);
    expect(step?.note).toBe("Permission was refused.");
    expect(activityRows([], feed.read().model)).toHaveLength(1);
  });
  it("never turns a stale cancelled proposal into delivered past-tense input", () => {
    const model = foldEvents(emptyModel(), [
      event(0, "action.intent", { verb: "click", label: "Click Save", risk: "none" }, "gui"),
      event(1, "action.cancel", { reason: "stale", detail: "Untrusted detail" }, "gui"),
    ]);
    expect(stepRows(model)[0]).toMatchObject({
      label: "Click Save",
      delivery: "proposed",
      status: "failed",
      reason: "The target changed before input.",
    });
    expect(stepRows(model)[0]?.reason).not.toContain("Untrusted");
  });
});
