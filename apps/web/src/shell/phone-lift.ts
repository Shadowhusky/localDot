import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterMotion } from "../ui/finished.ts";
import { matches, REDUCED_MOTION } from "../ui/media.ts";
import { clamp, lerp, onSpringFrame, Spring } from "./phone-spring.ts";

const RISE = { response: 0.32, damping: 0.78 };
const FALL = { response: 0.3, damping: 1 };
// This near its place, what is left of the spring's tail can't be seen, and whatever fades with the
// lift has gone, so it lands.
const LANDED_T = 0.02;
const LANDED_PX = 0.25;
// What a copy of something pressed or held must not bring along.
const PASSING = ["id", "data-pressed", "data-holding", "data-moved", "data-gone"];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const boxOf = (rect: DOMRect): Box => ({
  x: rect.left,
  y: rect.top,
  w: rect.width,
  h: rect.height,
});

export const mix = (from: Box, to: Box, t: number): Box => ({
  x: lerp(from.x, to.x, t),
  y: lerp(from.y, to.y, t),
  w: lerp(from.w, to.w, t),
  h: lerp(from.h, to.h, t),
});

// 0 up to `from`, 1 from `to`, easing between.
export function ramp(t: number, from: number, to: number): number {
  const u = clamp((t - from) / (to - from));
  return u * u * (3 - 2 * u);
}

function strip(element: Element) {
  for (const name of PASSING) element.removeAttribute(name);
}

// Its size in the page's layout, whatever is scaling it, and to the fraction: offsetWidth rounds, which
// would rewrap a copy or scale it off its pixels.
export function sizeOf(element: HTMLElement): { w: number; h: number } {
  const style = getComputedStyle(element);
  const whole = style.boxSizing === "border-box";
  const round = (value: string, ...around: string[]) =>
    Number.parseFloat(value) +
    (whole ? 0 : around.reduce((sum, each) => sum + (Number.parseFloat(each) || 0), 0));
  const w = round(
    style.width,
    style.paddingLeft,
    style.paddingRight,
    style.borderLeftWidth,
    style.borderRightWidth,
  );
  const h = round(
    style.height,
    style.paddingTop,
    style.paddingBottom,
    style.borderTopWidth,
    style.borderBottomWidth,
  );
  return {
    w: Number.isFinite(w) ? w : element.offsetWidth,
    h: Number.isFinite(h) ? h : element.offsetHeight,
  };
}

// A neighbour in name only, so what asks about its neighbours gets the same answer.
function standIn(sibling: Element | null): Element[] {
  if (!sibling) return [];
  const empty = sibling.cloneNode(false) as HTMLElement;
  strip(empty);
  empty.style.display = "none";
  return [empty];
}

// Puts into `host` a copy of `source` that draws exactly as it does: the rules that style it are
// mostly written against where it sits, so it goes in a chain of its ancestors' names that draws no
// box of its own but still hands down what they do. `host` takes its size.
export function copyInto(host: HTMLElement, source: HTMLElement) {
  const copy = source.cloneNode(true) as HTMLElement;
  const painted = source.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((canvas, index) => {
    const from = painted[index];
    if (from?.width && from.height) canvas.getContext("2d")?.drawImage(from, 0, 0);
  });
  // Whatever was moving in what it came from would start over in the copy.
  for (const each of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    strip(each);
    each.style.animation = "none";
    each.style.transition = "none";
  }
  Object.assign(copy.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    minWidth: "0",
    maxWidth: "none",
    minHeight: "0",
    maxHeight: "none",
    margin: "0",
    transform: "none",
    translate: "none",
    scale: "none",
    opacity: "1",
  });
  let outer = copy;
  for (
    let child: HTMLElement = source, at = source.parentElement;
    at && at !== document.body;
    child = at, at = at.parentElement
  ) {
    const shell = at.cloneNode(false) as HTMLElement;
    strip(shell);
    shell.style.display = "contents";
    shell.append(
      ...standIn(child.previousElementSibling),
      outer,
      ...standIn(child.nextElementSibling),
    );
    outer = shell;
  }
  host.replaceChildren(outer);
  const size = sizeOf(source);
  host.style.width = `${size.w}px`;
  host.style.height = `${size.h}px`;
}

export interface Lifted {
  // What it lifts out of, and goes back into.
  from: HTMLElement;
}

export interface LiftScene {
  // Where it rests, lifted.
  place: Box;
  // What dims the page behind it, which comes and goes with it.
  dim: HTMLElement | null;
  // Draws it `t` of the way from `source`, where the thing it came from is this frame, to its place.
  draw(t: number, source: Box): void;
  // Copies what it came from again, as that may have changed since it lifted.
  refresh(): void;
}

// A sheet or dialog opened over it by the choice that closed it: going home, it would pass over that
// and then vanish under it.
function covered(layer: Element | null): boolean {
  for (let next = layer?.nextElementSibling; next; next = next.nextElementSibling)
    if (next.matches('.ui-layer:not([data-closing]):is([data-kind="sheet"], [data-kind="dialog"])'))
      return true;
  return false;
}

// A thing lifted out of the page: what it came from is hidden, and a copy springs from it to its place
// and back, from wherever it has got to, reading each frame where it came from now is, so it lands on
// those pixels however the page has moved, and the two change over in one frame. If what it came from
// has gone, or gone behind something, the copy fades on its way instead. Under reduced motion nothing
// travels: the copy fades in and out over what it came from.
class Lift {
  private readonly t = new Spring(0);
  private readonly still = matches(REDUCED_MOTION);
  private stop = () => {};
  private falling = false;
  private hidden = false;
  private last: Box;
  private cancelFade = () => {};
  private frameAfter = 0;

  constructor(
    private readonly source: HTMLElement,
    private readonly scene: LiftScene,
    private readonly layer: HTMLElement | null,
    private readonly landed: () => void,
  ) {
    this.last = boxOf(source.getBoundingClientRect());
  }

  rise(): void {
    if (this.still) {
      this.scene.draw(1, this.scene.place);
      return;
    }
    this.hide();
    this.stop = onSpringFrame(this.frame);
    if (this.scene.dim) this.scene.dim.style.transition = "none";
    this.t.to(1, RISE);
    this.frame();
  }

  fall(): void {
    this.falling = true;
    if (this.still) {
      this.cancelFade = afterMotion([this.layer], () => queueMicrotask(this.land));
      return;
    }
    if (this.visible()) this.scene.refresh();
    this.t.to(0, { ...FALL, done: this.land });
    this.frame();
  }

  dispose(): void {
    this.cancelFade();
    cancelAnimationFrame(this.frameAfter);
    this.stop();
    this.t.set(this.t.x);
    this.reveal();
  }

  private readonly frame = () => {
    if (this.visible()) this.last = boxOf(this.source.getBoundingClientRect());
    else if (this.falling) {
      this.reveal();
      this.layer?.setAttribute("data-gone", "");
    }
    this.scene.draw(this.t.x, this.last);
    if (this.scene.dim) this.scene.dim.style.opacity = String(clamp(this.t.x));
    if (!this.falling) return;
    const { place } = this.scene;
    const away = Math.hypot(place.x - this.last.x, place.y - this.last.y, place.w - this.last.w);
    if (this.t.x < LANDED_T && this.t.x * away < LANDED_PX) this.t.set(0, true);
  };

  // Drawn exactly on its place for one frame first, so the change over shows nothing.
  private readonly land = () => {
    this.stop();
    if (this.still) {
      this.finish();
      return;
    }
    if (this.visible()) this.last = boxOf(this.source.getBoundingClientRect());
    this.scene.draw(0, this.last);
    if (this.scene.dim) this.scene.dim.style.opacity = "0";
    this.frameAfter = requestAnimationFrame(this.finish);
  };

  private readonly finish = () => {
    this.reveal();
    this.landed();
  };

  private visible(): boolean {
    return this.source.isConnected && !this.source.closest("[inert]") && !covered(this.layer);
  }

  // By opacity, not visibility: what is out of sight can drop its decoded pictures and come back
  // without them for a frame.
  private hide(): void {
    if (this.hidden) return;
    this.hidden = true;
    this.source.style.transition = "none";
    this.source.style.opacity = "0";
  }

  private reveal(): void {
    if (!this.hidden) return;
    this.hidden = false;
    this.source.style.removeProperty("opacity");
    this.source.style.removeProperty("transition");
  }
}

// Runs a lift for each thing held, until it has landed after being let go: `scene` sets it up once
// its layers are on the page, and `flight` is the layer that holds the copy.
export function useLift<T extends Lifted>(
  held: T | null,
  flight: RefObject<HTMLElement | null>,
  scene: (shown: T) => LiftScene | null,
): { shown: T | null; leaving: boolean } {
  const [shown, setShown] = useState(held);
  if (held && held !== shown) setShown(held);
  const leaving = !held && !!shown;
  const lift = useRef<Lift | null>(null);
  const setUp = useRef(scene);
  setUp.current = scene;

  useLayoutEffect(() => {
    const drawn = shown && setUp.current(shown);
    if (!shown || !drawn) return;
    const running = new Lift(shown.from, drawn, flight.current, () =>
      flushSync(() => setShown(null)),
    );
    lift.current = running;
    running.rise();
    return () => {
      running.dispose();
      lift.current = null;
    };
  }, [shown, flight]);

  useLayoutEffect(() => {
    if (!leaving) return;
    if (lift.current) lift.current.fall();
    else setShown(null);
  }, [leaving]);

  return { shown, leaving };
}
