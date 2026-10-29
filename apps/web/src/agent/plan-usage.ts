import {
  type PlanProvider,
  type PlanUsage,
  PlanUsageReply,
  type PlanUsageWindow,
} from "@localdot/protocol";
import { count } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { NEAR_LIMIT } from "../ui/Meter.tsx";

// Figures older than this say how old they are.
const STALE_MS = 10 * 60_000;

export async function loadPlanUsage(
  api: ApiClient,
  fresh: boolean,
  signal?: AbortSignal,
): Promise<PlanUsageReply> {
  return PlanUsageReply.parse(
    await api.get(`/api/agent/plan-usage${fresh ? "?fresh=1" : ""}`, { signal }),
  );
}

export function limitName(minutes: number | undefined, fallback: string): string {
  if (minutes === 10_080) return "Weekly limit";
  if (minutes !== undefined && minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return fallback;
}

export type PlanTone = "normal" | "near" | "limit";
export interface WindowView {
  window: PlanUsageWindow["window"];
  name: string;
  usedPercent: number;
  // Milliseconds since the epoch.
  resetsAt?: number;
  // The window has started again since it was read, so its figure no longer holds.
  reset: boolean;
}
export interface PlanView {
  provider: PlanProvider;
  plan?: string;
  windows: WindowView[];
  // The plan's limit, while it holds, and when it lifts if the plan said.
  limit?: { liftsAt?: number };
  // When the oldest figure shown was read, once that is long enough ago to say.
  asOf?: number;
  tone: PlanTone;
}

// A plan's figures as they stand at `now`: a window past its reset time has started again, and
// a limit holds until the time it lifts. Usage only grows within a window, so an old figure is
// still the least the plan has used until the window resets.
export function planView(plan: PlanUsage, now: number): PlanView {
  const windows = plan.windows.map((window) => {
    const resetsAt = window.resetsAt === undefined ? undefined : window.resetsAt * 1000;
    return {
      window: window.window,
      name: limitName(
        window.windowMinutes,
        window.window === "primary" ? "Short limit" : "Long limit",
      ),
      usedPercent: window.usedPercent,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      reset: resetsAt !== undefined && resetsAt <= now,
    };
  });
  const full = windows.filter((window) => window.usedPercent >= 100);
  const lifts =
    plan.limitResetsAt === undefined
      ? full.length && full.every((window) => window.resetsAt !== undefined)
        ? Math.max(...full.map((window) => window.resetsAt ?? 0))
        : undefined
      : plan.limitResetsAt * 1000;
  const held = (plan.limitReached || full.length > 0) && !(lifts !== undefined && lifts <= now);
  const oldest = windows.length
    ? Math.min(...plan.windows.map((window) => window.observedAt))
    : plan.observedAt;
  return {
    provider: plan.provider,
    ...(plan.plan ? { plan: plan.plan } : {}),
    windows,
    ...(held ? { limit: lifts === undefined ? {} : { liftsAt: lifts } } : {}),
    ...(now - oldest > STALE_MS ? { asOf: oldest } : {}),
    tone: held
      ? "limit"
      : windows.some((window) => !window.reset && window.usedPercent >= NEAR_LIMIT * 100)
        ? "near"
        : "normal",
  };
}

// The share shown: never 100% before the limit is reached.
export const shownPercent = (used: number) => (used >= 100 ? 100 : Math.floor(used));

// "in 2 h 14 min", "in 4 days 3 h".
export function untilText(at: number, now: number): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  const days = Math.floor(hours / 24);
  return `in ${count(days, "day", "days")}${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

// "3:40 PM" today, "Fri 3:40 PM" within the week, else "Oct 30, 3:40 PM".
export function exactTime(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  if (Math.abs(at - now) < 6 * 86_400_000)
    return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

// "12 min ago", "3 h ago", "Oct 20".
export function agoText(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}
