import type { PlanUsage } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { agoText, planView, shownPercent, untilText } from "./plan-usage.ts";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const S = (ms: number) => Math.round(ms / 1000);
const plan = (over: Partial<PlanUsage> = {}): PlanUsage => ({
  provider: "claude-code",
  plan: "max",
  windows: [
    {
      window: "primary",
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: S(NOW + 2 * 3_600_000),
      observedAt: NOW - 60_000,
    },
    {
      window: "secondary",
      usedPercent: 12,
      windowMinutes: 10_080,
      resetsAt: S(NOW + 4 * 86_400_000),
      observedAt: NOW - 60_000,
    },
  ],
  limitReached: false,
  observedAt: NOW - 60_000,
  ...over,
});
const at = (usedPercent: number, resetsIn?: number) => ({
  window: "primary" as const,
  usedPercent,
  windowMinutes: 300,
  ...(resetsIn === undefined ? {} : { resetsAt: S(NOW + resetsIn) }),
  observedAt: NOW - 60_000,
});

describe("a plan's usage as it stands now", () => {
  it("names the five-hour and weekly limits and keeps fresh figures as they are", () => {
    const view = planView(plan(), NOW);
    expect(view.windows.map((row) => [row.name, row.usedPercent, row.reset])).toEqual([
      ["5-hour limit", 42, false],
      ["Weekly limit", 12, false],
    ]);
    expect(view.tone).toBe("normal");
    expect(view).not.toHaveProperty("limit");
    expect(view).not.toHaveProperty("asOf");
  });

  it("is near the limit from 90% of a window that hasn't reset", () => {
    expect(planView(plan({ windows: [at(90, 60_000)] }), NOW).tone).toBe("near");
    expect(planView(plan({ windows: [at(95, -60_000)] }), NOW).tone).toBe("normal");
  });

  it("holds a reached limit until the time it lifts, then lets it go", () => {
    const reached = plan({ limitReached: true, limitResetsAt: S(NOW + 3_600_000) });
    expect(planView(reached, NOW).limit).toEqual({ liftsAt: NOW + 3_600_000 });
    expect(planView(reached, NOW).tone).toBe("limit");
    const later = planView(reached, NOW + 3_600_000);
    expect(later).not.toHaveProperty("limit");
    expect(later.tone).toBe("normal");
  });

  it("takes a used-up window's reset as the limit's lift when the plan named none", () => {
    const view = planView(plan({ windows: [at(100, 600_000)], limitReached: true }), NOW);
    expect(view.limit).toEqual({ liftsAt: NOW + 600_000 });
    expect(planView(plan({ windows: [at(100, -1)], limitReached: true }), NOW).limit).toBe(
      undefined,
    );
  });

  it("keeps a reached limit with no known lift, saying how old the news is", () => {
    const old = NOW - 3 * 3_600_000;
    const view = planView(plan({ windows: [], limitReached: true, observedAt: old }), NOW);
    expect(view.limit).toEqual({});
    expect(view.asOf).toBe(old);
  });

  it("marks a window past its reset as reset rather than showing its old figure", () => {
    const view = planView(plan({ windows: [at(97, -60_000)] }), NOW);
    expect(view.windows[0]).toMatchObject({ reset: true, usedPercent: 97 });
    expect(view.tone).toBe("normal");
  });

  it("dates the figures by the oldest window once it is over ten minutes old", () => {
    const windows = plan().windows.map((row, i) => ({
      ...row,
      observedAt: NOW - (i ? 11 : 1) * 60_000,
    }));
    expect(planView(plan({ windows }), NOW).asOf).toBe(NOW - 11 * 60_000);
    expect(planView(plan(), NOW)).not.toHaveProperty("asOf");
  });

  it("names a window it knows no length of by its place", () => {
    const view = planView(
      plan({
        windows: [
          { window: "primary", usedPercent: 1, observedAt: NOW },
          { window: "secondary", usedPercent: 1, windowMinutes: 43_200, observedAt: NOW },
        ],
      }),
      NOW,
    );
    expect(view.windows.map((row) => row.name)).toEqual(["Short limit", "720-hour limit"]);
  });
});

describe("plan usage words", () => {
  it("never rounds a share up to the limit", () => {
    expect([0.4, 37.6, 99.9, 100].map(shownPercent)).toEqual([0, 37, 99, 100]);
  });
  it("says how long until a reset", () => {
    expect(untilText(NOW + 20_000, NOW)).toBe("in under a minute");
    expect(untilText(NOW + 45 * 60_000, NOW)).toBe("in 45 min");
    expect(untilText(NOW + 2 * 3_600_000 + 14 * 60_000, NOW)).toBe("in 2 h 14 min");
    expect(untilText(NOW + 3 * 3_600_000, NOW)).toBe("in 3 h");
    expect(untilText(NOW + 4 * 86_400_000 + 3 * 3_600_000, NOW)).toBe("in 4 days 3 h");
    expect(untilText(NOW + 86_400_000, NOW)).toBe("in 1 day");
  });
  it("says how old a reading is", () => {
    expect(agoText(NOW - 12 * 60_000, NOW)).toBe("12 min ago");
    expect(agoText(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
  });
});
