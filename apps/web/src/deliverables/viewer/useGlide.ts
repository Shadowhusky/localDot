import { type SpringParams, springValue } from "@localdot/stage";
import { useCallback, useEffect, useRef } from "react";
import { springVelocity } from "../../dot/engine/spring.ts";

// Critically damped for a press or a key; a little give only after a flick (design-v2 §7).
export const SETTLE: SpringParams = { dampingRatio: 1, response: 0.35 };
export const MOMENTUM: SpringParams = { dampingRatio: 0.8, response: 0.35 };
export const FLICK = 300;

// A place along a row of pages: a float that a spring carries to each page from wherever it is, so
// a press during a glide redirects it and keeps its speed.
export function useGlide(start: number, reduced: boolean, paint: (place: number) => void) {
  const place = useRef(start);
  const speed = useRef(0);
  const goal = useRef(start);
  const frame = useRef(0);
  const painter = useRef(paint);
  painter.current = paint;

  const halt = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);
  const jump = useCallback(
    (to: number) => {
      halt();
      goal.current = to;
      place.current = to;
      speed.current = 0;
      painter.current(to);
    },
    [halt],
  );
  const glide = useCallback(
    (to: number, velocity: number, spring: SpringParams) => {
      if (reduced) return jump(to);
      halt();
      goal.current = to;
      const from = place.current;
      const start = performance.now();
      const step = (now: number) => {
        const t = (now - start) / 1000;
        place.current = springValue(from, to, velocity, t, spring);
        speed.current = springVelocity(from, to, velocity, t, spring);
        if (t > spring.response * 2 && Math.abs(place.current - to) < 0.001) {
          place.current = to;
          speed.current = 0;
          frame.current = 0;
        } else frame.current = requestAnimationFrame(step);
        painter.current(place.current);
      };
      frame.current = requestAnimationFrame(step);
    },
    [halt, jump, reduced],
  );
  useEffect(() => halt, [halt]);
  return { place, speed, goal, glide, jump, halt };
}
