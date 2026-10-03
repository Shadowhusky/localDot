import { describe, expect, it } from "vitest";
import { parseEvent } from "./events.ts";

const envelope = { v: 1, id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", seq: 0, t: 0, agent: "main" } as const;
const data = {
  provider: "chatgpt",
  plan: "plus",
  windows: [
    { window: "primary", usedPercent: 19, windowMinutes: 300, resetsAt: 1790900000 },
    { window: "secondary", usedPercent: 3, windowMinutes: 10080 },
  ],
  limitReached: false,
};
const parse = (value: unknown) =>
  parseEvent({ ...envelope, type: "subscription.usage", data: value });

describe("subscription usage protocol", () => {
  it("carries measured plan windows without dollar accounting", () => {
    expect(parse(data).data).toEqual(data);
  });
  it("preserves unknown windows as absent rather than inventing zero usage", () => {
    expect(parse({ provider: "chatgpt", windows: [], limitReached: false }).data).toEqual({
      provider: "chatgpt",
      windows: [],
      limitReached: false,
    });
  });
  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])("refuses invalid usage %s", (value) => {
    expect(() =>
      parse({ ...data, windows: [{ window: "primary", usedPercent: value }] }),
    ).toThrow();
  });
  it("refuses other providers, duplicate windows and invalid time fields", () => {
    for (const windows of [
      [...data.windows, data.windows[0]],
      [data.windows[0], data.windows[0]],
      [{ window: "other", usedPercent: 1 }],
      [{ window: "primary", usedPercent: 1, windowMinutes: 0 }],
      [{ window: "primary", usedPercent: 1, resetsAt: -1 }],
    ])
      expect(() => parse({ ...data, windows })).toThrow();
    expect(() => parse({ ...data, provider: "claude" })).toThrow();
  });
  it("refuses credential or dollar fields at the subscription boundary", () => {
    expect(() => parse({ ...data, apiKey: "fixture-only", spentUSD: 0.1 })).toThrow();
    expect(() =>
      parse({ ...data, windows: [{ window: "primary", usedPercent: 1, costUSD: 1 }] }),
    ).toThrow();
  });
});
