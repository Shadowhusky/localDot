import { parseEvent, ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { subscriptionUsage } from "./usage.ts";

describe("subscription usage event formatting", () => {
  it("preserves the two measured windows without inventing dollar spend", () => {
    const data = subscriptionUsage({
      primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1790900000 },
      secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1791400000 },
      planType: "plus",
      rateLimitReachedType: null,
    });
    expect(data).toEqual({
      provider: "chatgpt",
      plan: "plus",
      windows: [
        { window: "primary", usedPercent: 7, windowMinutes: 300, resetsAt: 1790900000 },
        { window: "secondary", usedPercent: 1, windowMinutes: 10080, resetsAt: 1791400000 },
      ],
      limitReached: false,
    });
    expect(
      parseEvent({
        v: 1,
        id: ulid(),
        seq: 0,
        t: 0,
        agent: "main",
        type: "subscription.usage",
        data,
      }).type,
    ).toBe("subscription.usage");
    expect(JSON.stringify(data)).not.toMatch(/usd|cost|price|budget/i);
  });
  it("keeps absent windows absent, preserves measured zero and marks a reached limit", () => {
    expect(subscriptionUsage({ primary: null, secondary: null })).toEqual({
      provider: "chatgpt",
      windows: [],
      limitReached: false,
    });
    expect(
      subscriptionUsage({
        primary: { usedPercent: 0, resetsAt: 0 },
        rateLimitReachedType: "primary",
      }),
    ).toEqual({
      provider: "chatgpt",
      windows: [{ window: "primary", usedPercent: 0, resetsAt: 0 }],
      limitReached: true,
      limitResetsAt: 0,
    });
    expect(subscriptionUsage({ secondary: { usedPercent: 100 } })).toEqual({
      provider: "chatgpt",
      windows: [{ window: "secondary", usedPercent: 100 }],
      limitReached: true,
    });
  });
  it("says when a reached limit lifts only when every window that reached it said", () => {
    const primary = { usedPercent: 100, windowDurationMins: 300, resetsAt: 1790900000 };
    const secondary = { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1791400000 };
    expect(subscriptionUsage({ primary, secondary })?.limitResetsAt).toBe(1791400000);
    expect(
      subscriptionUsage({ primary, secondary: { ...secondary, resetsAt: null } }),
    ).not.toHaveProperty("limitResetsAt");
    expect(
      subscriptionUsage({ primary: { ...primary, usedPercent: 40 }, rateLimitReachedType: "plan" }),
    ).toMatchObject({ limitReached: true });
    expect(
      subscriptionUsage({ primary: { ...primary, usedPercent: 40 }, rateLimitReachedType: "plan" }),
    ).not.toHaveProperty("limitResetsAt");
  });
  it.each([NaN, Infinity, -1, 101])(
    "refuses invalid measured percentage %s rather than clamping it",
    (usedPercent) => {
      expect(subscriptionUsage({ primary: { usedPercent } })).toBeUndefined();
    },
  );
  it("omits unknown plan labels and all unrelated snapshot fields", () => {
    expect(
      subscriptionUsage({
        planType: "https://fixture.invalid/token=SENTINEL",
        primary: null,
        extra: "SENTINEL",
      } as never),
    ).toEqual({ provider: "chatgpt", windows: [], limitReached: false });
  });
});
