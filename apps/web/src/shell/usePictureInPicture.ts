import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { project } from "../ui/sheet-drag.ts";
import { clamp, onSpringFrame, Spring, Velocity } from "./phone-spring.ts";

export type PipCorner = "top-right" | "top-left" | "bottom-left" | "bottom-right";

// Apple's picture in picture moves critically damped, in about 0.4 s.
const MOVE = { response: 0.4, damping: 1 };
// A finger that travels less than this has tapped.
const SLOP = 8;
// From the conversation's sides, and between the picture and the text it keeps clear of.
const GAP = 12;
// A finger on the thread that travels this far up or down is reading it.
const READING = 10;
const REARM_MS = 600;
// A scroll that has sent nothing for this long has come to rest.
const REST_MS = 160;

interface Point {
  x: number;
  y: number;
}
interface Box extends Point {
  w: number;
  h: number;
}

const boxOf = (element: Element): Box => {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
const pictureIn = (host: HTMLElement | null) =>
  host?.querySelector<HTMLElement>(".stage-box > .stage") ?? null;
const threadIn = (app: Element | null) =>
  app?.querySelector<HTMLElement>(".rail-chat .thread-body > .thread-scroll") ?? null;
const px = (value: string) => Number.parseFloat(value) || 0;

// As large as iOS makes one on an iPhone: two fifths of the width, within reason.
const sizeFor = (home: Box, room: number) => {
  const w = Math.round(clamp(room * 0.4, 140, 240));
  return { w, h: Math.round((w * home.h) / home.w) };
};

// Where the picture rests in each corner: just under the island, where the screen's own box begins,
// or just over the toolbar, the gap in from either side. Neither moves as the conversation takes
// the screen's room.
function restsIn(app: Element, home: Box, size: { w: number; h: number }) {
  const rail = app.querySelector<HTMLElement>(".rail-chat") ?? app;
  const foot = rail.querySelector<HTMLElement>(".thread-foot");
  const sides = rail.getBoundingClientRect();
  const top = home.y + GAP;
  const bottom = (foot ? foot.getBoundingClientRect().top : sides.bottom) - GAP - size.h;
  const left = sides.left + GAP;
  const right = sides.right - GAP - size.w;
  return {
    "top-right": { x: right, y: top },
    "top-left": { x: left, y: top },
    "bottom-left": { x: left, y: bottom },
    "bottom-right": { x: right, y: bottom },
  } satisfies Record<PipCorner, Point>;
}

function nearest(rests: Record<PipCorner, Point>, to: Point): PipCorner {
  let best: PipCorner = "top-right";
  let distance = Number.POSITIVE_INFINITY;
  for (const [corner, rest] of Object.entries(rests) as [PipCorner, Point][]) {
    const d = Math.hypot(rest.x - to.x, rest.y - to.y);
    if (d < distance) {
      distance = d;
      best = corner;
    }
  }
  return best;
}

// How much of its height the conversation keeps clear for the picture resting at `rest`: above its
// first line, or between its last and the toolbar; measured from where the thread would be with no
// band at all.
function bandFor(app: HTMLElement, corner: PipCorner, rest: Point, h: number): number {
  const scroll = threadIn(app);
  if (!scroll) return 0;
  const box = scroll.getBoundingClientRect();
  const kept = px(app.style.getPropertyValue("--pip-band"));
  const at = app.dataset.pip ?? "";
  if (corner.startsWith("top")) {
    const top = box.top - (at.startsWith("top") ? kept : 0);
    return Math.max(0, Math.round(rest.y + h + GAP - top));
  }
  const bottom = box.bottom + (at.startsWith("bottom") ? kept : 0);
  return Math.max(0, Math.round(bottom - (rest.y - GAP)));
}

// The thread as it was read before its box moved, so its text stays where the eye left it, or at
// the end if that is where it was.
interface Reading {
  scroll: HTMLElement;
  top: number;
  scrolled: number;
  end: boolean;
}

function reading(app: Element | null): Reading | null {
  const scroll = threadIn(app);
  if (!scroll) return null;
  return {
    scroll,
    top: scroll.getBoundingClientRect().top,
    scrolled: scroll.scrollTop,
    end: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 2,
  };
}

function keep(read: Reading | null): void {
  if (!read?.scroll.isConnected) return;
  const { scroll } = read;
  scroll.scrollTop = read.end
    ? scroll.scrollHeight - scroll.clientHeight
    : read.scrolled + (scroll.getBoundingClientRect().top - read.top);
}

// The live picture tucked into a corner, as iOS's picture in picture. Its box stays in its place and
// only the picture moves, drawn by springs: it shrinks to the corner and grows back along the same
// path, follows a finger 1:1 from where it was held, and goes to the corner it was thrown towards
// with the throw's speed. `on`, it floats in its corner; `roomy`, the conversation has taken the
// screen's room and keeps a band clear for it, above its text or over its toolbar, so it never
// covers a line. `host` holds the stage; a `.stage-pip` button in the picture is what a finger holds
// and what a tap brings back.
export function usePictureInPicture(
  host: RefObject<HTMLElement | null>,
  on: boolean,
  roomy: boolean,
): void {
  const springs = useRef({ x: new Spring(), y: new Spring(), s: new Spring(1) });
  const home = useRef<Box | null>(null);
  const corner = useRef<PipCorner>("top-right");
  const shown = useRef(on);
  shown.current = on;
  const room = useRef(roomy);
  room.current = roomy;
  const mounted = useRef(false);

  // Read before the change is laid out; reading it after would read the new layout.
  const was = useRef({ on, roomy });
  const before = useRef<Reading | null>(null);
  if (was.current.roomy !== roomy) before.current = reading(host.current?.closest(".app") ?? null);

  const paint = useRef(() => {
    const picture = pictureIn(host.current);
    const at = home.current;
    if (!picture || !at) return;
    const { x, y, s } = springs.current;
    if (!shown.current && !x.moving && !y.moving && !s.moving) {
      picture.style.translate = "";
      picture.style.scale = "";
      delete picture.dataset.floating;
      home.current = null;
      return;
    }
    picture.dataset.floating = "";
    picture.style.translate = `${x.x - at.x}px ${y.x - at.y}px`;
    picture.style.scale = `${s.x}`;
  });
  useEffect(() => onSpringFrame(paint.current), []);
  // A picture put back in the page while it is tucked away goes straight to where it was.
  useLayoutEffect(() => {
    const picture = pictureIn(host.current);
    if (on && picture && !("floating" in picture.dataset)) paint.current();
  });

  // The band the conversation keeps clear for the picture in its corner, set or taken away as the
  // conversation takes the screen's room or gives it back, its text kept where it was read.
  const lay = useRef((app: HTMLElement) => {
    const at = home.current;
    if (!room.current || !at) {
      delete app.dataset.pip;
      app.style.removeProperty("--pip-band");
      return;
    }
    const size = sizeFor(at, app.querySelector(".rail-chat")?.clientWidth ?? at.w);
    const rest = restsIn(app, at, size)[corner.current];
    const band = bandFor(app, corner.current, rest, size.h);
    app.dataset.pip = corner.current;
    app.style.setProperty("--pip-band", `${band}px`);
  });

  // Into its corner, or back to its place, from wherever it is now; and the room it is given.
  useLayoutEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    const floated = was.current.on !== on;
    const laid = was.current.roomy !== roomy;
    was.current = { on, roomy };
    const read = before.current;
    before.current = null;
    const picture = pictureIn(host.current);
    const app = host.current?.closest<HTMLElement>(".app");
    const box = picture?.parentElement;
    if (!picture || !app || !box || (!floated && !laid && !first)) return;
    const { x, y, s } = springs.current;
    if (!on) {
      if (first) return;
      lay.current(app);
      keep(read);
      const at = boxOf(box);
      home.current = at;
      x.to(at.x, MOVE);
      y.to(at.y, MOVE);
      s.to(1, MOVE);
      return;
    }
    const at = boxOf(box);
    const away = home.current !== null;
    home.current = at;
    if (laid || first) {
      lay.current(app);
      keep(read);
    }
    if (!floated && !first) return;
    const size = sizeFor(at, app.querySelector(".rail-chat")?.clientWidth ?? at.w);
    const rest = restsIn(app, at, size)[corner.current];
    picture.dataset.floating = "";
    if (first || !away) {
      x.set(at.x);
      y.set(at.y);
      s.set(1);
    }
    if (first) {
      x.set(rest.x);
      y.set(rest.y);
      s.set(size.w / at.w);
      return;
    }
    x.to(rest.x, MOVE);
    y.to(rest.y, MOVE);
    s.to(size.w / at.w, MOVE);
  }, [host, on, roomy]);

  // A finger on the tucked picture. Nothing under it hears the finger, and a tap is left to the
  // button's own click, which a keyboard gives as well.
  useEffect(() => {
    const app = host.current?.closest<HTMLElement>(".app");
    const handle = host.current?.querySelector<HTMLElement>(".stage-pip");
    if (!on || !app || !handle) return;
    const { x, y } = springs.current;
    let finger: {
      id: number;
      from: Point;
      at: Point;
      moved: boolean;
      vx: Velocity;
      vy: Velocity;
    } | null = null;
    let dragged = false;
    const rests = () => {
      const at = home.current;
      if (!at) return null;
      return restsIn(app, at, sizeFor(at, app.querySelector(".rail-chat")?.clientWidth ?? at.w));
    };
    const goTo = (next: PipCorner, velocity: Point = { x: 0, y: 0 }) => {
      if (next !== corner.current) {
        const read = reading(app);
        corner.current = next;
        lay.current(app);
        keep(read);
      }
      const rest = rests()?.[next];
      if (!rest) return;
      x.to(rest.x, { ...MOVE, velocity: velocity.x });
      y.to(rest.y, { ...MOVE, velocity: velocity.y });
    };
    const down = (event: PointerEvent) => {
      if (!event.isPrimary || event.button > 0) return;
      event.stopPropagation();
      dragged = false;
      x.set(x.x);
      y.set(y.x);
      finger = {
        id: event.pointerId,
        from: { x: event.clientX, y: event.clientY },
        at: { x: x.x, y: y.x },
        moved: false,
        vx: new Velocity(),
        vy: new Velocity(),
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser no longer tracks; the handle still hears it while it is over it.
      }
    };
    const move = (event: PointerEvent) => {
      if (!finger || event.pointerId !== finger.id) return;
      event.stopPropagation();
      const dx = event.clientX - finger.from.x;
      const dy = event.clientY - finger.from.y;
      if (!finger.moved && Math.hypot(dx, dy) < SLOP) return;
      finger.moved = true;
      x.set(finger.at.x + dx);
      y.set(finger.at.y + dy);
      finger.vx.add(x.x);
      finger.vy.add(y.x);
    };
    const up = (event: PointerEvent) => {
      if (!finger || event.pointerId !== finger.id) return;
      event.stopPropagation();
      const held = finger;
      finger = null;
      // Held still, it goes on to its corner; the tap's click brings it back if it was one.
      if (!held.moved) {
        goTo(corner.current);
        return;
      }
      dragged = true;
      const velocity = { x: held.vx.get(), y: held.vy.get() };
      const places = rests();
      if (!places) return;
      goTo(
        nearest(places, { x: x.x + project(velocity.x), y: y.x + project(velocity.y) }),
        velocity,
      );
    };
    // The click a drag ends with is the drag's, not a tap.
    const click = (event: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // Rotated, resized or with the keyboard up, it keeps to its corner.
    const settle = () => {
      const box = pictureIn(host.current)?.parentElement;
      if (!box || finger) return;
      const at = boxOf(box);
      home.current = at;
      lay.current(app);
      springs.current.s.to(
        sizeFor(at, app.querySelector(".rail-chat")?.clientWidth ?? at.w).w / at.w,
        MOVE,
      );
      goTo(corner.current);
    };
    handle.addEventListener("pointerdown", down);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    handle.addEventListener("click", click, true);
    window.addEventListener("resize", settle);
    window.visualViewport?.addEventListener("resize", settle);
    return () => {
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.removeEventListener("click", click, true);
      window.removeEventListener("resize", settle);
      window.visualViewport?.removeEventListener("resize", settle);
    };
  }, [host, on]);
}

const scrolls = (element: Element) =>
  element.scrollHeight > element.clientHeight + 1 &&
  /auto|scroll/.test(getComputedStyle(element).overflowY);

// Reading back through the conversation tucks the screen away: a finger or a wheel of the user's
// own on a thread with more to show, never a scroll that follows dot's new lines. Says whether that
// reading is still going on: the conversation takes the screen's room only once it has come to
// rest, as a change to the thread's box under a finger or a glide would catch it mid-move.
export function useTuckOnReading(enabled: boolean, tuck: () => void): boolean {
  const latest = useRef(tuck);
  latest.current = tuck;
  const [going, setGoing] = useState(false);
  const pressed = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    // Not the glide of a wheel that was going when the screen came back; a finger is always new.
    const armed = performance.now() + REARM_MS;
    // On the thread, where it or a list in it has more to show.
    const thread = (target: EventTarget | null) => {
      const scroll =
        target instanceof Element
          ? target.closest(".rail-chat .thread-body > .thread-scroll")
          : null;
      if (!scroll) return false;
      for (let at: Element | null = target as Element; at; at = at.parentElement) {
        if (scrolls(at)) return true;
        if (at === scroll) break;
      }
      return false;
    };
    let start: Point | null = null;
    const read = (finger: boolean) => {
      pressed.current = finger;
      setGoing(true);
      latest.current();
    };
    const touched = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      start = touch && thread(event.target) ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const moved = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dy = Math.abs(touch.clientY - start.y);
      if (dy < READING || dy < Math.abs(touch.clientX - start.x)) return;
      start = null;
      read(true);
    };
    const wheeled = (event: WheelEvent) => {
      if (
        performance.now() > armed &&
        Math.abs(event.deltaY) > Math.abs(event.deltaX) &&
        thread(event.target)
      )
        read(false);
    };
    document.addEventListener("touchstart", touched, { capture: true, passive: true });
    document.addEventListener("touchmove", moved, { capture: true, passive: true });
    document.addEventListener("wheel", wheeled, { capture: true, passive: true });
    return () => {
      document.removeEventListener("touchstart", touched, { capture: true });
      document.removeEventListener("touchmove", moved, { capture: true });
      document.removeEventListener("wheel", wheeled, { capture: true });
    };
  }, [enabled]);
  // At rest: no finger on the page, and nothing has scrolled or turned a wheel for a moment.
  useEffect(() => {
    if (!going) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = () => {
      clearTimeout(timer);
      if (!pressed.current) timer = setTimeout(() => setGoing(false), REST_MS);
    };
    const down = () => {
      pressed.current = true;
      clearTimeout(timer);
    };
    const lifted = (event: TouchEvent) => {
      if (event.touches.length) return;
      pressed.current = false;
      wait();
    };
    const options = { capture: true, passive: true } as const;
    document.addEventListener("scroll", wait, options);
    document.addEventListener("wheel", wait, options);
    document.addEventListener("touchstart", down, options);
    document.addEventListener("touchend", lifted, options);
    document.addEventListener("touchcancel", lifted, options);
    wait();
    return () => {
      clearTimeout(timer);
      document.removeEventListener("scroll", wait, options);
      document.removeEventListener("wheel", wait, options);
      document.removeEventListener("touchstart", down, options);
      document.removeEventListener("touchend", lifted, options);
      document.removeEventListener("touchcancel", lifted, options);
    };
  }, [going]);
  return going;
}
