import { type LocalDotEvent, ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { pickProofFrames } from "./proof.ts";
import { scanEvents } from "./task-scan.ts";

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, step?: string, t = seq * 1000) =>
  ({
    v: 1,
    id: ulid(),
    seq: seq++,
    t,
    agent: "main",
    type,
    data,
    ...(step ? { step } : {}),
  }) as LocalDotEvent;
const observe = (step: string) => ev("observe", { frameId: ulid(), width: 1, height: 1 }, step);
const frameOf = (e: LocalDotEvent | undefined) => (e?.type === "observe" ? e.data.frameId : "");
const all = () => true;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing");
  return value;
}

describe("proof frames", () => {
  it("takes start, the frame after the largest file change, and end", () => {
    seq = 0;
    const events = [
      observe("a"),
      observe("b"),
      ev("file.change", { path: "x", op: "modify", patch: "+".repeat(300) }, "c"),
      observe("c"),
      ev("file.change", { path: "y", op: "modify", patch: "+" }, "d"),
      observe("d"),
      observe("e"),
      ev("task.result", { summary: "s", files: [] }),
    ];
    const ids = events.filter((e) => e.type === "observe").map(frameOf);
    const picked = pickProofFrames(required(scanEvents(events).results[0]), all);
    expect(picked.map((p) => [p.role, p.frameId])).toEqual([
      ["start", ids[0]],
      ["change", ids[2]],
      ["end", ids[4]],
    ]);
  });
  it("falls back to the step whose screen changed most, then to the middle", () => {
    seq = 0;
    const events = [
      observe("a"),
      ev(
        "screen.settle",
        { frameT: 0, changed: [{ x: 0, y: 0, w: 10, h: 10 }], noVisibleChange: false },
        "b",
      ),
      observe("b"),
      ev(
        "screen.settle",
        { frameT: 0, changed: [{ x: 0, y: 0, w: 500, h: 500 }], noVisibleChange: false },
        "c",
      ),
      observe("c"),
      observe("d"),
      ev("task.result", { summary: "s", files: [] }),
    ];
    expect(pickProofFrames(required(scanEvents(events).results[0]), all)[1]?.frameId).toBe(
      frameOf(events[4]),
    );
    seq = 0;
    const plain = [observe("a"), observe("b"), observe("c"), observe("d"), observe("e")];
    const scan = scanEvents([...plain, ev("task.result", { summary: "s", files: [] })]);
    expect(pickProofFrames(required(scan.results[0]), all)[1]?.frameId).toBe(frameOf(plain[2]));
  });
  it("skips screenshots that are gone and shows fewer frames rather than a broken one", () => {
    seq = 0;
    const events = [
      observe("a"),
      observe("b"),
      observe("c"),
      ev("task.result", { summary: "s", files: [] }),
    ];
    const gone = frameOf(events[1]);
    const picked = pickProofFrames(required(scanEvents(events).results[0]), (id) => id !== gone);
    expect(picked.map((p) => p.role)).toEqual(["start", "end"]);
  });
  it("gives each result of a follow-up its own turn and check", () => {
    seq = 0;
    const events = [
      observe("a"),
      ev("step.verify", { status: "success", evidence: "opens, 4 sheets" }),
      ev("task.result", { summary: "one", files: [] }),
      observe("b"),
      ev("step.verify", { status: "failed", evidence: "would not open" }),
      ev("task.result", { summary: "two", files: [] }),
    ];
    const [first, second] = scanEvents(events).results;
    expect([first?.checked, second?.checked]).toEqual(["opens, 4 sheets", null]);
    expect(second?.frames).toHaveLength(1);
    expect(second?.startMs).toBe(first?.tMs);
  });
});
