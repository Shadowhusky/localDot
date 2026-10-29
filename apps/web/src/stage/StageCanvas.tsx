import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Flip } from "./probe.ts";
import type { PumpStats } from "./pump.ts";
import {
  holdEngine,
  type StageCanvasHandle,
  type StageEngine,
  type StageView,
} from "./stage-engine.ts";

export interface StageCanvasProps {
  // Shares the engine under this key and keeps it across remounts (the live stage). Read on mount.
  keep?: object;
  onStats?(stats: PumpStats): void;
  onFlip?(flip: Flip): void;
  onView?(view: StageView): void;
}

// Places the stage engine's canvas where this component sits. The engine renders only where frames
// can be tapped, so jsdom and browsers without WebCodecs never reach it.
export const StageCanvas = forwardRef<StageCanvasHandle, StageCanvasProps>(function StageCanvas(
  { keep, onStats, onFlip, onView },
  ref,
) {
  const anchor = useRef<HTMLTemplateElement>(null);
  const engine = useRef<StageEngine | null>(null);
  const [key] = useState(() => keep ?? null);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const onFlipRef = useRef(onFlip);
  onFlipRef.current = onFlip;
  const onViewRef = useRef(onView);
  onViewRef.current = onView;

  useLayoutEffect(() => {
    const slot = anchor.current;
    const held = holdEngine(key);
    engine.current = held.engine;
    if (slot) held.engine.place(slot);
    const offStats = held.engine.onStats((stats) => onStatsRef.current?.(stats));
    const offFlip = held.engine.onFlip((flip) => onFlipRef.current?.(flip));
    const offView = held.engine.onView((view) => onViewRef.current?.(view));
    return () => {
      offStats();
      offFlip();
      offView();
      if (slot) held.engine.unplace(slot);
      held.release();
    };
  }, [key]);

  // Declared after the layout effect above, so the engine is held by the time the handle is made.
  useImperativeHandle(ref, () => engine.current as StageEngine, []);

  return <template ref={anchor} />;
});
