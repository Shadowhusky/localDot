import type { PlanUsageReply } from "@localdot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { loadPlanUsage } from "./plan-usage.ts";

// Read often enough for the chip to notice a limit; often while the menu shows the figures.
const POLL_MS = 60_000;
const WATCH_MS = 5_000;

export interface PlanUsageFeed {
  reply: PlanUsageReply | null;
  // Asks for fresh figures: the plans whose figures are old are read from their apps.
  refresh(): void;
  // Keeps the figures current while something shows them, until the returned stop.
  watch(): () => void;
}

// The subscription plans' usage as localDot last heard it, while any plan is in use.
export function usePlanUsage(api: ApiClient, enabled: boolean): PlanUsageFeed {
  const [reply, setReply] = useState<PlanUsageReply | null>(null);
  const [watching, setWatching] = useState(0);
  const latest = useRef(0);
  const load = useCallback(
    async (fresh: boolean, signal?: AbortSignal) => {
      const asked = ++latest.current;
      try {
        const next = await loadPlanUsage(api, fresh, signal);
        if (asked !== latest.current) return;
        setReply((shown) =>
          shown && JSON.stringify(shown) === JSON.stringify(next) ? shown : next,
        );
      } catch {
        // The last figures stay, with their own age, through an outage.
      }
    },
    [api],
  );
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const look = () => {
      if (!document.hidden) void load(false, abort.signal);
    };
    look();
    const timer = window.setInterval(look, watching ? WATCH_MS : POLL_MS);
    document.addEventListener("visibilitychange", look);
    return () => {
      abort.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", look);
    };
  }, [enabled, watching, load]);
  const refresh = useCallback(() => void load(true), [load]);
  const watch = useCallback(() => {
    setWatching((n) => n + 1);
    void load(true);
    return () => setWatching((n) => n - 1);
  }, [load]);
  return useMemo(() => ({ reply, refresh, watch }), [reply, refresh, watch]);
}
