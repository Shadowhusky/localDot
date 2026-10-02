import type { SessionModel } from "@localdot/stage";
import { useEffect, useMemo, useState } from "react";

// The HUD's "now" in session ms: the latest folded event's time plus the wall-clock time since it
// arrived, re-anchored on every model version and re-read once a second for the elapsed counter.
export function useNowMs(model: SessionModel, version: number): number {
  const [, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model is folded in place, so its version is what changes
  const anchor = useMemo(() => ({ t: latestT(model), wall: Date.now() }), [model, version]);
  useEffect(() => {
    const timer = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return anchor.t + (Date.now() - anchor.wall);
}

function latestT(model: SessionModel): number {
  let t = model.startT ?? 0;
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
  return model.ended ? Math.max(t, model.ended.t) : t;
}
