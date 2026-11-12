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
import { t } from "../i18n/index.ts";
import {
  clampWidth,
  dragWidth,
  holdWidth,
  type PanelWidth,
  readWidth,
  releaseWidth,
  saveWidth,
  shownWidth,
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
  // Which of the panel's edges this is: dragging it outward widens the panel, the stage giving up
  // the room.
  side?: "left" | "right";
  // What else shares the page's width with the panel and the stage: another panel, or its room.
  beside?: PanelWidth | number;
  // Opening, or in a smaller window, this panel keeps its width and that other panel gives way, down
  // to its minimum. A drag still stops where the stage would go under its own.
  first?: boolean;
  className?: string;
}

export function ResizeHandle({
  panel,
  property,
  label,
  side = "left",
  beside = 0,
  first = false,
  className,
}: ResizeHandleProps) {
  const outward = side === "left" ? -1 : 1;
  const limits = (other = typeof beside === "number" ? beside : shownWidth(beside)) =>
    widthLimits(panel, window.innerWidth, other);
  const fitted = () =>
    clampWidth(
      readWidth(panel),
      first && typeof beside !== "number" ? limits(beside.min) : limits(),
    );
  const now = useRef({ limits, fitted });
  now.current = { limits, fitted };
  const [width, setWidth] = useState(fitted);
  const [max, setMax] = useState(() => limits().max);
  const [dragging, setDragging] = useState(false);
  const live = useRef(width);
  const drag = useRef<{ pointer: number; x: number; start: number; moved: boolean } | null>(null);
  const settling = useRef(0);

  const apply = useCallback(
    (next: number) => {
      live.current = next;
      holdWidth(panel, Math.round(next));
      document.documentElement.style.setProperty(property, `${Math.round(next)}px`);
      setWidth(Math.round(next));
    },
    [panel, property],
  );

  const settle = useCallback(
    (to: number) => {
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
    },
    [apply],
  );

  const commit = (next: number) => {
    const to = clampWidth(next, limits());
    settle(to);
    saveWidth(panel, to);
  };

  useLayoutEffect(() => {
    apply(live.current);
    const fit = () => {
      setMax(now.current.limits().max);
      if (drag.current) return;
      cancelAnimationFrame(settling.current);
      const to = now.current.fitted();
      if (to !== live.current) apply(to);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
      cancelAnimationFrame(settling.current);
      releaseWidth(panel);
      document.documentElement.style.removeProperty(property);
    };
  }, [apply, panel, property]);

  // What shares the page opening or closing moves in step with it, and comes back when it leaves.
  const besideWas = useRef(beside);
  useLayoutEffect(() => {
    if (besideWas.current === beside || drag.current) return;
    besideWas.current = beside;
    setMax(now.current.limits().max);
    settle(now.current.fitted());
  }, [beside, settle]);

  const end = (event: PointerEvent<HTMLHRElement>) => {
    const held = drag.current;
    if (held?.pointer !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    // A press that moved nothing chose nothing: what a smaller window holds it at stays unsaved.
    if (held.moved) commit(live.current);
  };

  return (
    <hr
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={panel.min}
      aria-valuemax={max}
      title={t`Drag to resize. Double-click to reset.`}
      className={clsx("rail-resize", className)}
      data-dragging={dragging || undefined}
      onFocus={() => setMax(limits().max)}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        cancelAnimationFrame(settling.current);
        drag.current = {
          pointer: event.pointerId,
          x: event.clientX,
          start: live.current,
          moved: false,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const held = drag.current;
        if (held?.pointer !== event.pointerId) return;
        held.moved ||= event.clientX !== held.x;
        apply(dragWidth(held.start, (event.clientX - held.x) * outward, limits()));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => {
        saveWidth(panel, panel.initial);
        settle(clampWidth(panel.initial, limits()));
      }}
      onKeyDown={(event: KeyboardEvent<HTMLHRElement>) => {
        const sign =
          event.key === "ArrowLeft" ? -outward : event.key === "ArrowRight" ? outward : 0;
        if (!sign) return;
        event.preventDefault();
        cancelAnimationFrame(settling.current);
        const to = clampWidth(live.current + sign * (event.shiftKey ? BIG_STEP : STEP), limits());
        apply(to);
        saveWidth(panel, to);
      }}
    />
  );
}
