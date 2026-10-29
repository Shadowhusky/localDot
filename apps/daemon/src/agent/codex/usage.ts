import { RateLimitSnapshot } from "@localdot/codex-harness";
import type { SubscriptionUsageData, SubscriptionWindow } from "@localdot/protocol";

export type { SubscriptionUsageData } from "@localdot/protocol";

const plans = new Set(["free", "go", "plus", "pro", "team", "business", "enterprise", "edu"]);

// Pure formatting of a measured notification. Invalid measurements are unknown, never clamped
// into apparently measured usage. No account reads, reset actions, keyd routes or prices occur.
export function subscriptionUsage(snapshot: RateLimitSnapshot): SubscriptionUsageData | undefined {
  const parsed = RateLimitSnapshot.safeParse(snapshot);
  if (!parsed.success) return;
  const s = parsed.data,
    windows: SubscriptionWindow[] = [];
  for (const [window, value] of [
    ["primary", s.primary],
    ["secondary", s.secondary],
  ] as const) {
    if (!value) continue;
    windows.push({
      window,
      usedPercent: value.usedPercent,
      ...(value.windowDurationMins != null ? { windowMinutes: value.windowDurationMins } : {}),
      ...(value.resetsAt != null ? { resetsAt: value.resetsAt } : {}),
    });
  }
  // The limit lifts when every window that reached it resets, if each said when.
  const reached = windows.filter(
    (w) => w.usedPercent === 100 || w.window === s.rateLimitReachedType,
  );
  const lifts = reached.flatMap((w) => w.resetsAt ?? []);
  const limitReached = Boolean(s.rateLimitReachedType) || reached.length > 0;
  return {
    provider: "chatgpt",
    ...(s.planType && plans.has(s.planType) ? { plan: s.planType } : {}),
    windows,
    limitReached,
    ...(limitReached && lifts.length && lifts.length === reached.length
      ? { limitResetsAt: Math.max(...lifts) }
      : {}),
  };
}
