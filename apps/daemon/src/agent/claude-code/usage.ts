import type { SubscriptionUsageData, SubscriptionWindow } from "@localdot/protocol";
import { z } from "zod";

const Limit = z.looseObject({
  utilization: z.number().nullish(),
  resets_at: z.string().max(64).nullish(),
});
// The part of Claude Code's `/usage` data that describes the plan's limits. Its percentages run
// from 0 to 100, unlike the fractions on rate_limit_event.
const UsageReply = z.looseObject({
  subscription_type: z.string().nullish(),
  rate_limits_available: z.boolean(),
  rate_limits: z.looseObject({ five_hour: Limit.nullish(), seven_day: Limit.nullish() }).nullish(),
});

const LIMITS = [
  ["five_hour", "primary", 300],
  ["seven_day", "secondary", 10_080],
] as const;

// The plan's five-hour and weekly limits as Claude Code reports them, or nothing when it reports
// none (an API key, another cloud, or a sign-in without the profile scope).
export function claudePlanUsage(reply: unknown, plan?: string): SubscriptionUsageData | undefined {
  const parsed = UsageReply.safeParse(reply);
  if (!parsed.success || !parsed.data.rate_limits_available || !parsed.data.rate_limits) return;
  const limits = parsed.data.rate_limits;
  const windows: SubscriptionWindow[] = [];
  for (const [name, window, minutes] of LIMITS) {
    const limit = limits[name];
    if (typeof limit?.utilization !== "number" || !Number.isFinite(limit.utilization)) continue;
    const resets = limit.resets_at ? Date.parse(limit.resets_at) : Number.NaN;
    windows.push({
      window,
      usedPercent: Math.round(Math.min(100, Math.max(0, limit.utilization)) * 10) / 10,
      windowMinutes: minutes,
      ...(Number.isFinite(resets) && resets >= 0 ? { resetsAt: Math.round(resets / 1000) } : {}),
    });
  }
  if (!windows.length) return;
  const reached = windows.filter((window) => window.usedPercent >= 100);
  const lifts = reached.flatMap((window) => window.resetsAt ?? []);
  const named = [parsed.data.subscription_type?.toLowerCase(), plan].find(
    (name) => name && /^[a-z0-9_-]{1,32}$/.test(name),
  );
  return {
    provider: "claude-code",
    ...(named ? { plan: named } : {}),
    windows,
    limitReached: reached.length > 0,
    ...(lifts.length === reached.length && lifts.length
      ? { limitResetsAt: Math.max(...lifts) }
      : {}),
  };
}
