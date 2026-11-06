import type { Wearable } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ShowDotControl } from "../dot/show-dot.ts";
import { matches, REDUCED_MOTION } from "../ui/media.ts";
import { boxIn, type Flyer, type FlyerBox } from "./phone-flyer.ts";
import { clamp, lerp, onSpringFrame, Spring } from "./phone-spring.ts";

const GLANCE_MS = 220;
// Where it looks before it goes, from its own middle, toward the ⋯ button.
const GLANCE = { x: 6, y: -4.5 };
// How far along the path the button takes it in.
const TAKEN_IN = 0.94;
const TUCKED_FRAME = 28;
// From here, over the button, it shrinks to this and fades, so nothing of it is left to vanish.
const GOING_IN = 0.975;
const TAKEN_SIZE = 0.3;
const LIFT_PX = 26;
const EARLY_LEAD = 0.18;

function along(from: FlyerBox, to: FlyerBox, t: number): FlyerBox {
  const u = Math.min(1, Math.max(0, t));
  const cx = from.x + (to.x - from.x) * EARLY_LEAD;
  const cy = to.y - LIFT_PX;
  return {
    x: (1 - u) * (1 - u) * from.x + 2 * u * (1 - u) * cx + u * u * to.x,
    y: (1 - u) * (1 - u) * from.y + 2 * u * (1 - u) * cy + u * u * to.y,
    w: lerp(from.w, to.w, u ** 1.3),
  };
}

// Drawn on its way between `from` and the button, going in about its own middle.
function drawAlong(flyer: Flyer, from: FlyerBox, to: FlyerBox, t: number) {
  const box = along(from, to, t);
  const taken = clamp((t - GOING_IN) / (1 - GOING_IN));
  const w = box.w * lerp(1, TAKEN_SIZE, taken);
  flyer.move({ x: box.x + (box.w - w) / 2, y: box.y + (box.w - w) / 2, w });
  flyer.fade(1 - taken);
}

// The ⋯ button taking dot in, or letting it out.
function absorb(button: HTMLElement | null) {
  if (!button || matches(REDUCED_MOTION) || typeof button.animate !== "function") return;
  button.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(1.28)", offset: 0.22 },
      { transform: "scale(.92)", offset: 0.55 },
      { transform: "scale(1)" },
    ],
    { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
  button.animate(
    [
      { boxShadow: "0 0 0 0 var(--color-fg-2)", opacity: 1 },
      { boxShadow: "0 0 0 16px transparent", opacity: 1 },
    ],
    { duration: 620, easing: "cubic-bezier(.23,1,.32,1)" },
  );
}

const slot = () => document.querySelector(".dot-strip .presence-slot");

export interface DotTuckHost {
  showDot: ShowDotControl;
  flyer: Flyer;
  more: { current: HTMLElement | null };
  look: readonly Wearable[];
}

// Minimal mode: from the dot's menu, "Hide dot": it glances at ⋯, hops into it, the button takes it
// in, and a tip says where it went. ⋯ then offers "Show dot", which runs the same path back.
export function useDotTuck({ showDot, flyer, more, look }: DotTuckHost) {
  const [coach, setCoach] = useState(false);
  const now = useRef({ showDot, look });
  now.current = { showDot, look };
  const running = useRef<(() => void) | null>(null);
  useEffect(() => () => running.current?.(), []);

  const target = useCallback(() => {
    const button = more.current;
    const root = flyer.root;
    if (!button || !root) return null;
    const box = boxIn(button, root);
    return {
      x: box.x + box.w / 2 - TUCKED_FRAME / 2,
      y: box.y + box.w / 2 - TUCKED_FRAME / 2,
      w: TUCKED_FRAME,
    };
  }, [flyer, more]);

  const hide = useCallback(() => {
    running.current?.();
    const from = slot();
    const root = flyer.root;
    const to = target();
    if (matches(REDUCED_MOTION) || !from || !root || !to) {
      now.current.showDot.change(false);
      setCoach(true);
      return;
    }
    const start = boxIn(from, root);
    const view = flyer.show(start, now.current.look);
    view?.setState("watching");
    view?.setFocus(GLANCE);
    let stop = () => {};
    const glance = setTimeout(() => {
      view?.setFocus(null);
      now.current.showDot.change(false);
      const t = new Spring(0);
      let taken = false;
      const draw = () => {
        drawAlong(flyer, start, to, t.x);
        if (t.x > TAKEN_IN && !taken) {
          taken = true;
          absorb(more.current);
        }
      };
      stop = onSpringFrame(draw);
      t.to(1, {
        response: 0.56,
        damping: 0.92,
        done: () => {
          stop();
          running.current = null;
          if (!taken) absorb(more.current);
          view?.setState("idle");
          flyer.hide();
          setCoach(true);
        },
      });
    }, GLANCE_MS);
    running.current = () => {
      clearTimeout(glance);
      stop();
      flyer.hide();
      running.current = null;
    };
  }, [flyer, more, target]);

  const show = useCallback(() => {
    running.current?.();
    setCoach(false);
    absorb(more.current);
    now.current.showDot.change(true);
    const to = target();
    if (matches(REDUCED_MOTION) || !to) return;
    const root = flyer.root;
    const view = root && flyer.show(to, now.current.look);
    if (!view || !root) return;
    flyer.fade(0);
    const t = new Spring(1);
    let stop = () => {};
    // The foot unfolds as dot lands, so it aims for wherever its place has got to.
    const frame = requestAnimationFrame(() => {
      const draw = () => {
        const place = slot();
        if (place) drawAlong(flyer, boxIn(place, root), to, t.x);
      };
      stop = onSpringFrame(draw);
      t.to(0, {
        response: 0.56,
        damping: 0.86,
        done: () => {
          stop();
          running.current = null;
          flyer.land();
        },
      });
    });
    running.current = () => {
      cancelAnimationFrame(frame);
      stop();
      flyer.hide();
      running.current = null;
    };
  }, [flyer, more, target]);

  return { hide, show, coach, coachDone: useCallback(() => setCoach(false), []) };
}
