import type { SessionModel } from "@localdot/stage";
import { useEffect, useMemo, useState } from "react";

// The HUD's "now" in session ms: the latest folded event's time plus the wall-clock time since it
// arrived, re-anchored on every model version. It re-reads once a second only while `running`
// holds at that event's time, so a waiting or finished task shows no ticking clock.
export function useNowMs(
  model: SessionModel,
  version: number,
  running: (t: number) => boolean,
): number {
  const [, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model is folded in place, so its version is what changes
  const anchor = useMemo(() => ({ t: latestT(model), wall: Date.now() }), [model, version]);
  const ticking = running(anchor.t);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return anchor.t + (Date.now() - anchor.wall);
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
