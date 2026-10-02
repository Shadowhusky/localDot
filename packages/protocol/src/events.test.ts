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

  it("accepts a dispatch carrying input, raw press time and ring onset", () => {
    const e = parseEvent({
      ...base,
      type: "action.dispatch",
      data: {
        input: { kind: "click", button: "left", count: 1, at: { x: 5, y: 6 } },
        pressT: 1_000_000,
        ringAt: 1_019_600,
        injector: "xtest",
      },
    });
    expect(e.type).toBe("action.dispatch");
  });

  it("rejects a dispatch without the press time", () => {
    expect(() =>
      parseEvent({
        ...base,
        type: "action.dispatch",
        data: { input: { kind: "click", button: "left", count: 1, at: { x: 5, y: 6 } } },
      }),
    ).toThrow();
  });

  it("rejects an envelope id that is not a ULID", () => {
    expect(() =>
      parseEvent({ ...base, id: "invalid", type: "agent.state", data: { state: "idle" } }),
    ).toThrow();
  });

  it("keeps observe frames out of the log", () => {
    const frameId = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
    const parsed = parseEvent({
      ...base,
      type: "observe",
      data: { frameId, image: "data:image/png;base64,AAAA", width: 1280, height: 800 },
    });
    expect(parsed.data).toEqual({ frameId, width: 1280, height: 800 });
    expect(() =>
      parseEvent({
        ...base,
        type: "observe",
        data: { frameId: "invalid", width: 1280, height: 800 },
      }),
    ).toThrow();
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

  it("accepts keyd's key use and budget events and bounds what a cell chose", () => {
    const keyUse = {
      secretId: "weather",
      host: "api.weather.example",
      method: "GET",
      path: "/v1",
      decision: "deny",
    };
    expect(parseEvent({ ...base, agent: "keyd", type: "key.use", data: keyUse }).type).toBe(
      "key.use",
    );
    expect(() =>
      parseEvent({
        ...base,
        agent: "keyd",
        type: "key.use",
        data: { ...keyUse, path: `/${"a".repeat(512)}` },
      }),
    ).toThrow();
    expect(
      parseEvent({
        ...base,
        agent: "keyd",
        type: "budget.exceeded",
        data: { scope: "day", limitUSD: 20, spentUSD: 20.01, needUSD: 0.4 },
      }).type,
    ).toBe("budget.exceeded");
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
