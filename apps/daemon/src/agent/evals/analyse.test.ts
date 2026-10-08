import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyseEvents, parseEvents, type RecordedEvent, summarize } from "./analyse.ts";

const evidence = parseEvents(
  readFileSync(new URL("./fixtures/evidence-events.jsonl", import.meta.url), "utf8"),
);
const tenth = (value: number | undefined) => Math.round((value ?? Number.NaN) * 10) / 10;

let seq = 0;
const at = (s: number, type: string, data: Record<string, unknown> = {}): RecordedEvent => ({
  seq: seq++,
  t: Math.round(s * 1e6),
  type,
  data,
});

describe("analyseEvents on the recorded GIMP session", () => {
  const report = analyseEvents(evidence);

  it("reproduces the per-action medians measured in the evidence", () => {
    expect(report.guiActions).toBe(17);
    expect(tenth(report.phases.preAuth?.median)).toBe(2.6);
    expect(tenth(report.phases.approvalWait?.median)).toBe(12);
    expect(tenth(report.phases.revalidate?.median)).toBe(2.5);
    expect(tenth(report.phases.travelFreshness?.median)).toBe(1.8);
    expect(tenth(report.phases.consume?.median)).toBe(3);
    expect(tenth(report.phases.settle?.median)).toBe(0.7);
    expect(tenth(report.phases.finalObserve?.median)).toBe(1.1);
    expect(tenth(report.phases.totalExclApproval?.median)).toBe(12.4);
    expect(tenth(report.phases.totalExclApproval?.min)).toBe(5.3);
    expect(tenth(report.phases.totalExclApproval?.max)).toBe(30.5);
  });

  it("reproduces the model latency and the safety counts", () => {
    expect(tenth(report.phases.modelLatency?.median)).toBe(3.5);
    expect(tenth(report.phases.modelLatency?.max)).toBe(50.4);
    expect(report.handoffs).toBe(3);
    expect(report.staleCancels).toBe(1);
    expect(report.approvalTimeouts).toBe(2);
    expect(report.repeatPauses).toBe(1);
    expect(report.modelTurns).toBe(45);
  });
});

describe("analyseEvents", () => {
  it("measures one approved click from step start to its result", () => {
    const report = analyseEvents([
      at(0, "step.start", { kind: "gui" }),
      at(1, "approval.request"),
      at(5, "approval.resolve", { by: "user" }),
      at(5.5, "action.intent", { verb: "click" }),
      at(6, "observe"),
      at(6.25, "action.dispatch"),
      at(6.5, "screen.settle"),
      at(7, "observe"),
      at(7, "action.result", { ok: true }),
      at(7.1, "step.end", { status: "ok" }),
    ]);
    expect(report.guiActions).toBe(1);
    expect(report.phases.preAuth?.median).toBe(1);
    expect(report.phases.approvalWait?.median).toBe(4);
    expect(report.phases.revalidate?.median).toBe(0.5);
    expect(report.phases.travelFreshness?.median).toBe(0.5);
    expect(report.phases.consume?.median).toBe(0.25);
    expect(report.phases.settle?.median).toBe(0.25);
    expect(report.phases.finalObserve?.median).toBe(0.5);
    expect(report.phases.totalExclApproval?.median).toBe(3);
  });

  it("starts the identity phase at the intent when no approval was asked", () => {
    const report = analyseEvents([
      at(0, "step.start", { kind: "gui" }),
      at(0.4, "action.intent", { verb: "key" }),
      at(0.6, "action.dispatch"),
      at(0.7, "screen.settle"),
      at(0.9, "action.result", { ok: true }),
    ]);
    expect(report.phases.preAuth?.median).toBeCloseTo(0.4);
    expect(report.phases.approvalWait).toBeNull();
    expect(report.phases.travelFreshness).toBeNull();
    expect(report.phases.consume).toBeNull();
    expect(report.phases.totalExclApproval?.median).toBeCloseTo(0.9);
  });

  it("skips steps that never dispatched and steps of other kinds", () => {
    const report = analyseEvents([
      at(0, "step.start", { kind: "gui" }),
      at(1, "action.intent", { verb: "click" }),
      at(2, "action.cancel", { reason: "stale" }),
      at(2, "step.end", { status: "failed" }),
      at(3, "step.start", { kind: "shell" }),
      at(3.5, "action.dispatch"),
      at(4, "step.end", { status: "ok" }),
    ]);
    expect(report.guiActions).toBe(0);
    expect(report.staleCancels).toBe(1);
    expect(report.failedSteps).toBe(1);
  });

  it("closes a step that has no end when the next step starts", () => {
    const report = analyseEvents([
      at(0, "step.start", { kind: "gui" }),
      at(1, "approval.request"),
      at(9, "step.start", { kind: "gui" }),
      at(9.5, "action.intent", { verb: "click" }),
      at(10, "action.dispatch"),
      at(10.5, "screen.settle"),
      at(11, "action.result", { ok: true }),
    ]);
    expect(report.guiActions).toBe(1);
    expect(report.phases.totalExclApproval?.median).toBe(2);
  });

  it("counts a repeat pause once across its pausing and paused events", () => {
    const pause = { requestId: "r1", reason: "repeated_action" };
    const report = analyseEvents([
      at(0, "safety.pause", { revision: 1, pause: { ...pause, phase: "pausing" } }),
      at(0.1, "safety.pause", { revision: 2, pause: { ...pause, phase: "paused" } }),
      at(5, "safety.pause", { revision: 3 }),
    ]);
    expect(report.repeatPauses).toBe(1);
  });
});

describe("summarize", () => {
  it("averages the middle pair of an even sample", () => {
    expect(summarize([4, 1, 3, 2])).toEqual({ n: 4, median: 2.5, p90: 4, min: 1, max: 4 });
    expect(summarize([])).toBeNull();
  });
});
