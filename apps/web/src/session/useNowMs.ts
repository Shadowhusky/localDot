import type { SessionModel } from "@localdot/stage";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type SessionClock, sessionMsAt } from "./clock-sync.ts";

const TICK_SLACK_MS = 15;
// What the page shows for a moment after an event has run its course by then: a past-tense label
// (1.2 s), a wince, a finished step or a helper still beside dot (under a second).
export const SETTLE_MS = 1300;

const viewerWallMs = () => performance.timeOrigin + performance.now();
const intoSecond = (ms: number) => ((ms % 1000) + 1000) % 1000;

// The session's time now, in session ms.
export type SessionNow = () => number;

// The HUD's "now" in session ms. With a synced clock it is the daemon's own now, so the timer runs
// on whether or not events arrive; before the first sync it is the latest folded event's time plus
// the wall-clock time since it arrived. It never runs backwards for one task. The page reads it
// again at the moment `next` names from now and the latest event's time, if any, and at once when
// it is shown again; `at` reads it between, for the parts of the page that count time by
// themselves (useSessionNow).
export function useNowMs(
  model: SessionModel,
  version: number,
  next: (t: number, latest: number) => number | null,
  clock: SessionClock | null = null,
): { now: number; at: SessionNow } {
  const [, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model is folded in place, so its version is what changes
  const anchor = useMemo(() => ({ t: latestT(model), wall: viewerWallMs() }), [model, version]);
  const read = useRef({ model, anchor, clock, shown: Number.NEGATIVE_INFINITY });
  if (read.current.model !== model) read.current.shown = Number.NEGATIVE_INFINITY;
  read.current.model = model;
  read.current.anchor = anchor;
  read.current.clock = clock;
  const [at] = useState<SessionNow>(() => () => {
    const r = read.current;
    const wall = viewerWallMs();
    let now = r.anchor.t + (wall - r.anchor.wall);
    if (r.clock && Number.isFinite(r.clock.offsetMicros - r.clock.originMicros))
      now = Math.max(now, sessionMsAt(wall, r.clock));
    now = Math.max(now, r.shown);
    r.shown = now;
    return now;
  });
  const now = at();
  const nextAt = next(now, anchor.t);
  const delay = nextAt === null ? null : Math.max(0, nextAt - now) + TICK_SLACK_MS;
  useEffect(() => {
    if (delay === null || document.visibilityState === "hidden") return;
    const timer = setTimeout(() => setTick((x) => x + 1), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  useShownAgain(() => setTick((x) => x + 1), true);
  return { now, at };
}

// The earliest of the moment the page may change by itself after its latest event and of `later`
// (a retry's deadline, a long think's turn of phrase), still to come at `t`.
export function nextChange(
  t: number,
  latest: number,
  later: readonly (number | null | undefined)[] = [],
): number | null {
  let next = Number.POSITIVE_INFINITY;
  for (const at of [latest + SETTLE_MS, ...later])
    if (typeof at === "number" && at > t && at < next) next = at;
  return Number.isFinite(next) ? next : null;
}

export const SessionNowContext = createContext<SessionNow | null>(null);

// The session's time for a part of the page that counts it by itself, read again on each whole
// second since `from` while `ticking`, so the page around it need not draw again for its clock.
export function useSessionNow(ticking: boolean, from = 0): number | null {
  const at = useContext(SessionNowContext);
  const [, setTick] = useState(0);
  const now = at ? at() : null;
  const delay = ticking && now !== null ? 1000 - intoSecond(now - from) + TICK_SLACK_MS : null;
  useEffect(() => {
    if (delay === null || document.visibilityState === "hidden") return;
    const timer = setTimeout(() => setTick((x) => x + 1), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  useShownAgain(() => setTick((x) => x + 1), ticking);
  return now;
}

function useShownAgain(again: () => void, on: boolean): void {
  const latest = useRef(again);
  latest.current = again;
  useEffect(() => {
    if (!on) return;
    const shownAgain = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    document.addEventListener("visibilitychange", shownAgain);
    window.addEventListener("pageshow", shownAgain);
    return () => {
      document.removeEventListener("visibilitychange", shownAgain);
      window.removeEventListener("pageshow", shownAgain);
    };
  }, [on]);
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
