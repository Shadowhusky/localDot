import { parseEvent } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { EventDriver } from "./event-driver.ts";
import type { Point } from "./gaze.ts";

// Real, schema-validated events, so the tests break if the protocol changes shape.
const ev = (type: string, data: unknown) =>
  parseEvent({ v: 1, id: "evt", seq: 0, t: 0, agent: "main", type, data });

const make = (toPage: (p: Point) => Point = (p) => p) => {
  let now = 0;
  const calls: string[] = [];
  let attention: Point | null | undefined;
  const driver = new EventDriver(
    {
      setState: (state) => {
        calls.push(`state:${state}`);
      },
      setAttention: (point) => {
        attention = point;
      },
      react: (kind) => {
        calls.push(`react:${kind}`);
        return true;
      },
    },
    toPage,
    () => now,
  );
  const at = (t: number) => {
    now = t;
  };
  const looking = () => {
    driver.update();
    return attention;
  };
  return { driver, calls, at, looking };
};

describe("EventDriver", () => {
  it("passes agent states through", () => {
    const d = make();
    d.driver.handle(ev("agent.state", { state: "thinking" }));
    expect(d.calls).toEqual(["state:thinking"]);
  });

  it("looks at an intent's point, mapped into the page", () => {
    const d = make((p) => ({ x: p.x / 2 + 100, y: p.y / 2 + 50 }));
    d.driver.handle(
      ev("action.intent", {
        verb: "click",
        label: "Save",
        point: { x: 200, y: 100 },
        risk: "none",
      }),
    );
    expect(d.looking()).toEqual({ x: 200, y: 100 });
  });

  it("prefers the centre of a target's box over its point", () => {
    const d = make();
    d.driver.handle(
      ev("action.target", {
        target: { point: { x: 0, y: 0 }, bbox: { x: 100, y: 100, w: 50, h: 20 }, source: "ax" },
      }),
    );
    expect(d.looking()).toEqual({ x: 125, y: 110 });
  });

  it("faces the user during an approval, nods on approve, then returns to the target", () => {
    const d = make();
    d.driver.handle(
      ev("action.intent", { verb: "click", label: "Send", point: { x: 10, y: 20 }, risk: "high" }),
    );
    d.driver.handle(
      ev("approval.request", {
        approvalId: "a1",
        kind: "send",
        title: "Send the report",
        risk: "high",
      }),
    );
    expect(d.looking()).toBeNull();
    d.at(1000);
    d.driver.handle(ev("approval.resolve", { approvalId: "a1", decision: "approve", by: "user" }));
    expect(d.calls).toContain("react:nod");
    expect(d.looking()).toEqual({ x: 10, y: 20 });
  });

  it("winces at an error and is annoyed by a second one within a minute", () => {
    const d = make();
    d.driver.handle(ev("action.result", { ok: false, error: "File is locked" }));
    d.at(30_000);
    d.driver.handle(ev("step.verify", { status: "failed" }));
    d.at(100_000);
    d.driver.handle(ev("session.end", { reason: "error" }));
    expect(d.calls).toEqual(["react:wince", "react:hmph", "react:wince"]);
  });

  it("looks at the largest changed region and ignores settles with no visible change", () => {
    const d = make();
    d.driver.handle(
      ev("screen.settle", {
        frameT: 0,
        changed: [
          { x: 0, y: 0, w: 10, h: 10 },
          { x: 100, y: 100, w: 200, h: 100 },
        ],
        noVisibleChange: false,
      }),
    );
    expect(d.looking()).toEqual({ x: 200, y: 150 });
    d.driver.handle(
      ev("screen.settle", {
        frameT: 1,
        changed: [{ x: 0, y: 0, w: 10, h: 10 }],
        noVisibleChange: true,
      }),
    );
    expect(d.looking()).toEqual({ x: 200, y: 150 });
  });

  it("cheers once the session is done", () => {
    const d = make();
    d.driver.handle(ev("session.end", { reason: "done" }));
    expect(d.calls).toEqual(["react:cheer"]);
  });

  it("does not react to chatter", () => {
    const d = make();
    d.driver.handle(ev("thought.delta", { text: "hmm" }));
    d.driver.handle(ev("heartbeat", { ongoing: true, everyMs: 1000 }));
    d.driver.handle(ev("tool.output", { stream: "stdout", chunk: "ok" }));
    expect(d.calls).toEqual([]);
    expect(d.looking()).toBeNull();
  });
});
