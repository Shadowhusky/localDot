import type { SessionModel } from "@localdot/stage";
import { useEffect, useMemo, useRef, useState } from "react";
import { type SessionClock, sessionMsAt } from "./clock-sync.ts";

const TICK_SLACK_MS = 15;

const viewerWallMs = () => performance.timeOrigin + performance.now();
const intoSecond = (ms: number) => ((ms % 1000) + 1000) % 1000;

// The HUD's "now" in session ms. With a synced clock it is the daemon's own now, so the timer runs
// on whether or not events arrive; before the first sync it is the latest folded event's time plus
// the wall-clock time since it arrived. It never runs backwards for one task, and while `running`
// holds it re-reads on each whole second of the task, and at once when the page is shown again.
export function useNowMs(
  model: SessionModel,
  version: number,
  running: (t: number) => boolean,
  clock: SessionClock | null = null,
): number {
  const [, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model is folded in place, so its version is what changes
  const anchor = useMemo(() => ({ t: latestT(model), wall: viewerWallMs() }), [model, version]);
  const shown = useRef({ model, t: 0 });
  const wall = viewerWallMs();
  let now = anchor.t + (wall - anchor.wall);
  const daemonNow = clock ? sessionMsAt(wall, clock) : Number.NaN;
  if (Number.isFinite(daemonNow)) now = Math.max(now, daemonNow);
  if (shown.current.model === model) now = Math.max(now, shown.current.t);
  shown.current = { model, t: now };
  const ticking = running(now);
  const delay = ticking ? 1000 - intoSecond(now - (model.startT ?? 0)) + TICK_SLACK_MS : null;
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(() => setTick((x) => x + 1), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  useEffect(() => {
    if (!ticking) return;
    const shownAgain = () => {
      if (document.visibilityState === "visible") setTick((x) => x + 1);
    };
    document.addEventListener("visibilitychange", shownAgain);
    window.addEventListener("pageshow", shownAgain);
    return () => {
      document.removeEventListener("visibilitychange", shownAgain);
      window.removeEventListener("pageshow", shownAgain);
    };
  }, [ticking]);
  return now;
}
function latestT(model: SessionModel): number {
  let t = Math.max(
    model.startT ?? 0,
    model.ended?.t ?? 0,
    model.agentStates.at(-1)?.t ?? 0,
    model.observes.at(-1)?.t ?? 0,
    model.plans.at(-1)?.t ?? 0,
    model.keyUses.at(-1)?.t ?? 0,
    model.marks.at(-1)?.t ?? 0,
    model.screenChanges.at(-1)?.t ?? 0,
  );
  for (const s of model.steps) t = Math.max(t, s.startT, s.endT ?? 0);
  for (const a of model.actions) {
    t = Math.max(
      t,
      a.intentT,
      a.targetT ?? 0,
      a.dispatch?.t ?? 0,
      a.settleT ?? 0,
      a.resultT ?? 0,
      a.cancel?.t ?? 0,
      a.progress.at(-1)?.t ?? 0,
    );
  }
  return t;
}
