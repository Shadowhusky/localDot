import { describe, expect, it } from "vitest";
import { claudePlanUsage } from "./usage.ts";

const reply = (rate_limits: unknown, over: Record<string, unknown> = {}) => ({
  session: { total_cost_usd: 0 },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits,
  behaviors: null,
  ...over,
});

describe("Claude Code's /usage data as plan usage", () => {
  it("reads the five-hour and weekly limits as percentages with their reset times", () => {
    expect(
      claudePlanUsage(
        reply({
          five_hour: { utilization: 37.25, resets_at: "2026-10-26T15:40:00.000Z" },
          seven_day: { utilization: 8, resets_at: "2026-10-30T09:00:00+00:00" },
          seven_day_opus: { utilization: 99, resets_at: null },
          extra_usage: { is_enabled: true, used_credits: 1200 },
        }),
      ),
    ).toEqual({
      provider: "claude-code",
      plan: "max",
      windows: [
        {
          window: "primary",
          usedPercent: 37.3,
          windowMinutes: 300,
          resetsAt: Date.parse("2026-10-26T15:40:00.000Z") / 1000,
        },
        {
          window: "secondary",
          usedPercent: 8,
          windowMinutes: 10_080,
          resetsAt: Date.parse("2026-10-30T09:00:00Z") / 1000,
        },
      ],
      limitReached: false,
    });
  });

  it("marks a used-up window as the reached limit, lifting when it resets", () => {
    const usage = claudePlanUsage(
      reply({
        five_hour: { utilization: 104, resets_at: "2026-10-26T15:40:00Z" },
        seven_day: { utilization: 61, resets_at: "2026-10-30T09:00:00Z" },
      }),
    );
    expect(usage?.windows[0]?.usedPercent).toBe(100);
    expect(usage?.limitReached).toBe(true);
    expect(usage?.limitResetsAt).toBe(Date.parse("2026-10-26T15:40:00Z") / 1000);
  });

  it("keeps a limit's lift unknown when a used-up window gave no reset time", () => {
    const usage = claudePlanUsage(
      reply({
        five_hour: { utilization: 100, resets_at: "2026-10-26T15:40:00Z" },
        seven_day: { utilization: 100, resets_at: null },
      }),
    );
    expect(usage?.limitReached).toBe(true);
    expect(usage).not.toHaveProperty("limitResetsAt");
  });

  it("leaves out a window it gave no figure for, and a reset time it can't read", () => {
    expect(
      claudePlanUsage(
        reply(
          {
            five_hour: { utilization: null, resets_at: "2026-10-26T15:40:00Z" },
            seven_day: { utilization: 3, resets_at: "next week" },
          },
          { subscription_type: null },
        ),
        "pro",
      ),
    ).toEqual({
      provider: "claude-code",
      plan: "pro",
      windows: [{ window: "secondary", usedPercent: 3, windowMinutes: 10_080 }],
      limitReached: false,
    });
  });

  it.each([
    ["no plan limits", reply(null, { rate_limits_available: false })],
    [
      "limits it calls unavailable",
      reply({ five_hour: { utilization: 5 } }, { rate_limits_available: false }),
    ],
    ["no figures", reply({ five_hour: null, seven_day: { utilization: null, resets_at: null } })],
    ["a malformed reply", { rate_limits: { five_hour: { utilization: "5%" } } }],
    ["nothing", undefined],
  ])("reports nothing for %s", (_, value) => {
    expect(claudePlanUsage(value)).toBeUndefined();
  });

  it("refuses a plan name that isn't one", () => {
    expect(
      claudePlanUsage(reply({ five_hour: { utilization: 1 } }, { subscription_type: "Max plan!" })),
    ).not.toHaveProperty("plan");
  });
});
