import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalDotEvent, parseEvent } from "./events.ts";

const base = { v: 1, id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", seq: 0, t: 0, agent: "main" } as const;

describe("parseEvent", () => {
  it("accepts an action intent", () => {
    const e = parseEvent({
      ...base,
      type: "action.intent",
      data: { verb: "click", label: "Click Search", point: { x: 10, y: 20 }, risk: "none" },
    });
    expect(e.type).toBe("action.intent");
  });

  it("accepts a dispatch carrying a typed input", () => {
    const e = parseEvent({
      ...base,
      type: "action.dispatch",
      data: { input: { kind: "click", button: "left", count: 1, at: { x: 5, y: 6 } } },
    });
    expect(e.type).toBe("action.dispatch");
  });

  it("rejects an unknown event type", () => {
    expect(() => parseEvent({ ...base, type: "action.teleport", data: {} })).toThrow();
  });

  it("rejects non-finite coordinates", () => {
    expect(() =>
      parseEvent({
        ...base,
        type: "action.intent",
        data: { verb: "click", label: "x", point: { x: Number.NaN, y: 0 }, risk: "none" },
      }),
    ).toThrow();
  });

  it("refuses masked typing progress that carries the typed text", () => {
    expect(() =>
      parseEvent({
        ...base,
        type: "text.progress",
        data: { chunk: "hunter2", count: 7, masked: true },
      }),
    ).toThrow(/masked/);
  });

  it("exports JSON Schema that names every event type", () => {
    const schema = JSON.stringify(z.toJSONSchema(LocalDotEvent, { unrepresentable: "any" }));
    for (const type of [
      "session.start",
      "action.intent",
      "action.dispatch",
      "approval.request",
      "key.use",
    ]) {
      expect(schema).toContain(type);
    }
  });
});
