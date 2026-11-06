import type { PlanUsageReply } from "@localdot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { loadPlanUsage } from "./plan-usage.ts";

// Read often enough for the chip to notice a limit; often while the menu shows the figures.
const POLL_MS = 60_000;
const WATCH_MS = 5_000;
// While the figures show they are asked for fresh this often. The daemon goes to a plan's own app
// only when its reading is old, and at most once a minute per plan, however many pages ask.
export const WATCH_FRESH_MS = 60_000;

export interface PlanUsageFeed {
  reply: PlanUsageReply | null;
  // Asks for fresh figures: the plans whose figures are old are read from their apps.
  refresh(): void;
  // Keeps the figures current while something shows them, until the returned stop.
  watch(): () => void;
}

// The subscription plans' usage as localDot last heard it, while any plan is in use. A turn that
// ends has spent some, so `working` going off asks for fresh figures.
export function usePlanUsage(api: ApiClient, enabled: boolean, working = false): PlanUsageFeed {
  const [reply, setReply] = useState<PlanUsageReply | null>(null);
  const [watching, setWatching] = useState(0);
  const latest = useRef(0);
  const asked = useRef(Number.NEGATIVE_INFINITY);
  const wasWorking = useRef(working);
  const load = useCallback(
    async (fresh: boolean, signal?: AbortSignal) => {
      const ask = ++latest.current;
      if (fresh) asked.current = Date.now();
      try {
        const next = await loadPlanUsage(api, fresh, signal);
        if (ask !== latest.current) return;
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
      if (document.hidden) return;
      void load(!!watching && Date.now() - asked.current >= WATCH_FRESH_MS, abort.signal);
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
  useEffect(() => {
    if (wasWorking.current && !working && enabled) void load(true);
    wasWorking.current = working;
  }, [working, enabled, load]);
  const refresh = useCallback(() => void load(true), [load]);
  const watch = useCallback(() => {
    setWatching((n) => n + 1);
    void load(true);
    return () => setWatching((n) => n - 1);
  }, [load]);
  return useMemo(() => ({ reply, refresh, watch }), [reply, refresh, watch]);
}
