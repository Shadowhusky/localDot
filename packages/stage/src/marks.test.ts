import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { markOf } from "./marks.ts";

const ev = (type: string, data: Record<string, unknown> = {}): LocalDotEvent =>
  ({
    v: 1,
    id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
    seq: 17,
    t: msToMicros(123),
    agent: "main",
    step: "s1",
    type,
    data,
  }) as LocalDotEvent;
const cases: [string, Record<string, unknown>, string, string, string][] = [
  ["takeover.request", {}, "takeover", "Asked you to take control", "user"],
  ["takeover.end", { by: "user" }, "handback", "Handed back to dot", "neutral"],
  ["takeover.end", { by: "stop" }, "pause", "Stopped during your control", "attention"],
  [
    "takeover.end",
    { by: "user", typed: true },
    "handback",
    "You typed, then handed back to dot",
    "neutral",
  ],
  ["takeover.end", { by: "stop", typed: true }, "pause", "You typed, then it stopped", "attention"],
  [
    "approval.request",
    { title: "Send a message" },
    "approval",
    "Asked to approve: Send a message",
    "attention",
  ],
  ["approval.resolve", { by: "timeout", decision: "deny" }, "decision", "Denied", "failure"],
  ["approval.resolve", { by: "user", decision: "approve" }, "decision", "Approved", "neutral"],
  ["approval.resolve", { by: "user", decision: "deny" }, "decision", "Denied", "failure"],
  [
    "approval.resolve",
    { by: "user", decision: "take_control" },
    "decision",
    "You took control",
    "user",
  ],
  [
    "takeover.request",
    { requestId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", reason: "other", note: "", by: "user" },
    "takeover",
    "You took control",
    "user",
  ],
  ["control.change", { holder: "user" }, "takeover", "You took control", "user"],
  ["control.change", { holder: "agent" }, "handback", "Handed back to dot", "neutral"],
  ["pause.change", { paused: true }, "pause", "Paused", "neutral"],
  ["pause.change", { paused: false }, "resume", "Resumed", "neutral"],
  ["tool.start", { title: "Read sheet" }, "tool", "Read sheet", "neutral"],
  ["tool.end", { ok: false, exitCode: 2 }, "tool-failed", "Command failed (exit 2)", "failure"],
  ["tool.end", { ok: false }, "tool-failed", "Command failed", "failure"],
  [
    "file.change",
    { op: "create", path: "/config/Documents/Q3 report.ods" },
    "file",
    "Created Q3 report.ods",
    "neutral",
  ],
  [
    "file.change",
    { op: "modify", path: "/config/Documents/Q3 report.ods" },
    "file",
    "Edited Q3 report.ods",
    "neutral",
  ],
  [
    "file.change",
    { op: "delete", path: "/config/Documents/Q3 report.ods" },
    "file",
    "Deleted Q3 report.ods",
    "neutral",
  ],
  ["memory.change", { file: "USER.md" }, "memory", "Updated USER.md", "neutral"],
  ["memory.change", { file: "MEMORY.md" }, "memory", "Updated MEMORY.md", "neutral"],
  ...(
    [
      ["allow", "Used a key", "neutral"],
      ["deny", "Blocked a key", "failure"],
      ["ask", "Asked to use a key", "attention"],
    ] as const
  ).map(([decision, label, tone]): [string, Record<string, unknown>, string, string, string] => [
    "key.use",
    { decision, host: "api.example.com" },
    "key",
    `${label} → api.example.com`,
    tone,
  ]),
  ["step.verify", { status: "success" }, "verify", "Verified", "neutral"],
  ["step.verify", { status: "unexpected" }, "verify", "Unexpected result", "attention"],
  ["step.verify", { status: "failed" }, "verify", "Check failed", "failure"],
];
describe("timeline marks", () => {
  it.each(cases)("labels %s as the event table requires", (type, data, kind, label, tone) => {
    expect(markOf(ev(type, data))).toEqual({
      t: 123,
      seq: 17,
      step: "s1",
      type,
      kind,
      label,
      tone,
    });
  });
  it("ignores events that have their own display", () => {
    for (const type of [
      "session.start",
      "session.end",
      "agent.state",
      "heartbeat",
      "thought.delta",
      "plan.set",
      "plan.update",
      "step.start",
      "step.end",
      "action.intent",
      "action.target",
      "action.dispatch",
      "action.result",
      "action.cancel",
      "text.progress",
      "screen.settle",
      "observe",
      "tool.output",
      "camera.hint",
    ])
      expect(markOf(ev(type))).toBeNull();
    expect(markOf(ev("tool.end", { ok: true }))).toBeNull();
  });
  it("keeps an unknown future type as a neutral mark without a step", () => {
    const e = ev("browser.switch");
    delete e.step;
    expect(markOf(e)).toEqual({
      t: 123,
      seq: 17,
      type: "browser.switch",
      kind: "event",
      label: "browser.switch",
      tone: "neutral",
    });
  });
  it("clips only display text and extracts basenames for Unix and Windows paths", () => {
    const title = "A".repeat(80);
    expect(markOf(ev("tool.start", { title }))?.label).toHaveLength(60);
    expect(markOf(ev("approval.request", { title }))?.label).toHaveLength(78);
    expect(
      markOf(ev("file.change", { op: "modify", path: "C:\\Users\\Richard\\report.ods" }))?.label,
    ).toBe("Edited report.ods");
    expect(
      markOf(ev("file.change", { op: "delete", path: `/a/${"x".repeat(80)}` }))?.label,
    ).toHaveLength(56);
  });
});
