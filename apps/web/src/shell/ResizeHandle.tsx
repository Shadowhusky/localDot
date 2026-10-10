import { clsx } from "clsx";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { reducedMotion } from "../agent/useFollowScroll.ts";
import {
  clampWidth,
  dragWidth,
  type PanelWidth,
  readWidth,
  saveWidth,
  widthLimits,
} from "./panel-width.ts";

const STEP = 16;
const BIG_STEP = 64;
const SETTLE_MS = 200;
const settleEase = (progress: number) => 1 - (1 - progress) ** 3;

export interface ResizeHandleProps {
  panel: PanelWidth;
  // The custom property that sizes the panel, set on the page's root over its token.
  property: string;
  label: string;
  className?: string;
}

// The edge at a panel's left: dragging it left widens the panel, the stage giving up the room.
export function ResizeHandle({ panel, property, label, className }: ResizeHandleProps) {
  const [width, setWidth] = useState(() =>
    clampWidth(readWidth(panel), widthLimits(panel, window.innerWidth)),
  );
  const [dragging, setDragging] = useState(false);
  const live = useRef(width);
  const drag = useRef<{ pointer: number; x: number; start: number } | null>(null);
  const settling = useRef(0);

  const apply = useCallback(
    (next: number) => {
      live.current = next;
      document.documentElement.style.setProperty(property, `${Math.round(next)}px`);
      setWidth(Math.round(next));
    },
    [property],
  );

  const settle = (to: number) => {
    cancelAnimationFrame(settling.current);
    const from = live.current;
    if (reducedMotion() || Math.abs(to - from) < 1) {
      apply(to);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / SETTLE_MS);
      apply(from + (to - from) * settleEase(progress));
      if (progress < 1) settling.current = requestAnimationFrame(step);
    };
    settling.current = requestAnimationFrame(step);
  };

  const commit = (next: number) => {
    const to = clampWidth(next, widthLimits(panel, window.innerWidth));
    settle(to);
    saveWidth(panel, to);
  };

  useLayoutEffect(() => {
    apply(live.current);
    const fit = () => {
      if (drag.current) return;
      cancelAnimationFrame(settling.current);
      const fitted = clampWidth(readWidth(panel), widthLimits(panel, window.innerWidth));
      if (fitted !== live.current) apply(fitted);
    };
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
      cancelAnimationFrame(settling.current);
      document.documentElement.style.removeProperty(property);
    };
  }, [apply, panel, property]);

  const end = (event: PointerEvent<HTMLHRElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    commit(live.current);
  };

  const limits = widthLimits(panel, window.innerWidth);
  return (
    <hr
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      title="Drag to resize. Double-click to reset."
      className={clsx("rail-resize", className)}
      data-dragging={dragging || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        cancelAnimationFrame(settling.current);
        drag.current = { pointer: event.pointerId, x: event.clientX, start: live.current };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const held = drag.current;
        if (held?.pointer !== event.pointerId) return;
        apply(dragWidth(held.start, held.x - event.clientX, widthLimits(panel, window.innerWidth)));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => commit(panel.initial)}
      onKeyDown={(event: KeyboardEvent<HTMLHRElement>) => {
        const sign = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
        if (!sign) return;
        event.preventDefault();
        cancelAnimationFrame(settling.current);
        const to = clampWidth(
          live.current + sign * (event.shiftKey ? BIG_STEP : STEP),
          widthLimits(panel, window.innerWidth),
        );
        apply(to);
        saveWidth(panel, to);
      }}
    />
  );
}
