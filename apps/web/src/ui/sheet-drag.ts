import { type SpringParams, springValue } from "@localdot/stage";

// A release whose projected resting place is past this share of the sheet's height closes it.
export const DISMISS_AT = 0.3;
// Movement before a press becomes a drag, so a tap on a control inside stays a tap.
const SLOP = 10;
// Velocity is read over the last stretch of movement only.
const WINDOW_MS = 100;
const SETTLE: SpringParams = { dampingRatio: 1, response: 0.3 };
// A flick carried momentum, so its landing may overshoot a little.
const FLICK: SpringParams = { dampingRatio: 0.8, response: 0.3 };
const FLICK_SPEED = 300;

// Where a release would come to rest if it decelerated like a scroll view (rate .998 per ms).
export function project(velocity: number, rate = 0.998): number {
  return ((velocity / 1000) * rate) / (1 - rate);
}

// Past the open position the sheet follows less and less, and never stops dead.
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

export type SheetDetent = "fit" | "medium" | "large";

// The top edge of a resting medium or large sheet, below the safe area. overlays.css holds the same
// numbers: medium keeps the stage in view, large leaves only the top 40.
export const DETENT_TOP = { medium: 238, large: 40 } as const;

// How far below the highest of them each detent rests.
export function detentStops(detents: readonly SheetDetent[]): number[] {
  const tops = detents.map((detent) => (detent === "fit" ? 0 : DETENT_TOP[detent]));
  const highest = Math.min(...tops);
  return tops.map((top) => top - highest);
}

export function nearestStop(landing: number, stops: readonly number[]): number {
  let nearest = 0;
  stops.forEach((stop, index) => {
    if (Math.abs(stop - landing) < Math.abs((stops[nearest] as number) - landing)) nearest = index;
  });
  return nearest;
}

// Where a release comes to rest: the stop nearest where it would land, or off the bottom edge once
// that landing is past the lowest stop by 30 % of the sheet still showing there.
export function restingStop(
  offset: number,
  velocity: number,
  stops: readonly number[],
  height: number,
): number | "dismiss" {
  const landing = offset + project(velocity);
  const lowest = Math.max(...stops);
  if (landing > lowest + (height - lowest) * DISMISS_AT) return "dismiss";
  return nearestStop(landing, stops);
}

// Whether a finger moving this way on a sheet's content takes the sheet rather than scrolling it:
// up while the sheet rests below its top height, to raise it; down once everything that scrolls
// under the finger is at its top, to lower it. A move more sideways than up or down never does.
export function takesSheet(dx: number, dy: number, lowered: boolean, atTop: boolean): boolean {
  if (dy === 0 || Math.abs(dx) > Math.abs(dy)) return false;
  return dy < 0 ? lowered : atTop;
}

// Whether everything that scrolls between a press and its sheet is scrolled to its top.
export function scrolledToTop(target: Element, panel: Element): boolean {
  for (let node: Element | null = target; node && node !== panel; node = node.parentElement)
    if (node.scrollTop > 0 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return false;
  return true;
}

interface Sample {
  t: number;
  y: number;
}

export function velocityOf(samples: readonly Sample[]): number {
  const last = samples.at(-1);
  if (!last) return 0;
  const first = samples.find((sample) => last.t - sample.t <= WINDOW_MS) ?? last;
  return last.t > first.t ? ((last.y - first.y) / (last.t - first.t)) * 1000 : 0;
}

export interface SheetDragHost {
  panel: HTMLElement;
  scrim: HTMLElement | null;
  // Where each of its detents rests, as an offset below the highest.
  stops(): readonly number[];
  // Called as a release settles into the detent at this index.
  rest(index: number): void;
  // Says whether the sheet may close. A sheet with unsaved changes asks first and stays.
  allowDismiss(): boolean;
  close(): void;
  reducedMotion(): boolean;
  // A bottom-anchored resizable sheet keeps its scroll area inside the visible height.
  presentation?: { read(): number; apply(offset: number): void; clear(): void };
}

// Where any pointer picks the sheet up: its grabber strip and its header. A press on a control
// there stays the control's.
const GRIP = "[data-sheet-grip]";
const CONTROL =
  "button, a[href], input, select, textarea, [contenteditable], [role=button], [role=link], [role=tab]";

interface Press {
  id: number;
  x: number;
  y: number;
  // A finger on the content, until its first move says whether the sheet or the content takes it.
  content: Element | null;
  // Whether the sheet rests below its top height; one still springing, where it is headed.
  lowered: boolean;
  dragging: boolean;
  // Where the sheet was when the finger landed: it then moves exactly as far as the finger does.
  from: number;
  // How far it may stretch up past rest: the surface it runs on below the screen.
  stretch: number;
  samples: Sample[];
}

// Tracks a bottom sheet 1:1 with the finger from where it was grabbed, then hands the release
// velocity to a spring: back to rest, or off the bottom edge. A sheet still moving can be grabbed
// again, from wherever it is on screen.
export function attachSheetDrag(host: SheetDragHost): () => void {
  const { panel, scrim } = host;
  let press: Press | undefined;
  let offset = 0;
  let frame = 0;
  // Where the spring under way is taking the sheet.
  let heading = 0;

  const apply = (value: number) => {
    offset = value;
    const height = panel.offsetHeight || 1;
    if (host.presentation) host.presentation.apply(value);
    else panel.style.translate = `0 ${value}px`;
    if (scrim) scrim.style.opacity = `${Math.min(1, Math.max(0, 1 - value / height))}`;
  };

  const settle = () => {
    panel.style.removeProperty("transition");
    panel.style.removeProperty("translate");
    host.presentation?.clear();
    scrim?.style.removeProperty("transition");
    scrim?.style.removeProperty("opacity");
    offset = 0;
  };

  const presented = (): number => {
    if (host.presentation) return host.presentation.read();
    const value = getComputedStyle(panel).translate;
    const y = value === "none" ? 0 : Number.parseFloat(value.split(" ")[1] ?? "0");
    return Number.isFinite(y) ? y : 0;
  };

  const animate = (to: number, velocity: number, done: () => void, leaving = false) => {
    heading = to;
    const from = offset;
    const params = Math.abs(velocity) >= FLICK_SPEED ? FLICK : SETTLE;
    const start = performance.now();
    const step = (now: number) => {
      const t = (now - start) / 1000;
      const value = springValue(from, to, velocity, t, params);
      const speed = (springValue(from, to, velocity, t + 0.001, params) - value) / 0.001;
      apply(value);
      const offscreen = leaving && value >= to;
      if (offscreen || (Math.abs(value - to) < 0.5 && Math.abs(speed) < 10)) {
        frame = 0;
        done();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  const release = (velocity: number) => {
    const height = panel.offsetHeight;
    const stops = host.stops();
    const decision = restingStop(offset, velocity, stops, height);
    if (decision === "dismiss" && host.allowDismiss()) {
      if (host.reducedMotion()) {
        // The sheet fades where it is instead of travelling.
        panel.style.removeProperty("transition");
        scrim?.style.removeProperty("transition");
        scrim?.style.removeProperty("opacity");
        host.close();
        return;
      }
      animate(
        height,
        velocity,
        () => {
          scrim?.style.removeProperty("opacity");
          scrim?.style.removeProperty("transition");
          host.close();
        },
        true,
      );
      return;
    }
    // Kept open (it may not close, or asks first), it rests at the height nearest the landing.
    const index =
      decision === "dismiss" ? nearestStop(offset + project(velocity), stops) : decision;
    const landed = () => {
      host.rest(index);
      settle();
    };
    if (host.reducedMotion()) return landed();
    animate(stops[index] ?? 0, velocity, landed);
  };

  const begin = (current: Press) => {
    current.dragging = true;
    cancelAnimationFrame(frame);
    frame = 0;
    panel.setPointerCapture(current.id);
    panel.style.transition = "none";
    if (scrim) scrim.style.transition = "none";
  };

  const onPointerDown = (event: PointerEvent) => {
    if (press || (event.pointerType === "mouse" && event.button !== 0)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const grip = target.closest(GRIP);
    const control = target.closest(CONTROL);
    if (grip && control && grip.contains(control)) return;
    if (event.pointerType === "mouse") {
      // Only a finger or a pen moves the sheet by its content: a mouse selects text there.
      if (!grip) return;
      // Nor does a mouse dragging a grip select the page it passes over. A touch's press is never
      // cancelled: WebKit would drop its tap's click.
      event.preventDefault();
    }
    const at = frame ? offset : presented();
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      content: grip ? null : target,
      lowered: (frame ? heading : at) > 0.5,
      dragging: false,
      from: at,
      stretch: Number.parseFloat(getComputedStyle(panel).paddingBottom) || 1,
      samples: [],
    };
    // A sheet still springing is caught at once by a grip; by the content, only once it takes it.
    if (frame && grip) begin(press);
  };

  // Whether the sheet takes the press: one on the content only if its first move goes the sheet's
  // way (see takesSheet), else the content scrolls and the press is let go. Unknown until it moves.
  const claims = (current: Press, x: number, y: number): boolean | undefined => {
    if (!current.content) return true;
    const dx = x - current.x;
    const dy = y - current.y;
    if (!dx && !dy) return undefined;
    if (!takesSheet(dx, dy, current.lowered, scrolledToTop(current.content, panel))) {
      press = undefined;
      return false;
    }
    current.content = null;
    // Caught on its way, it stops where it is and follows the finger from there.
    if (frame) {
      begin(current);
      current.from = offset;
      current.y = y;
    }
    return true;
  };

  const onPointerMove = (event: PointerEvent) => {
    const current = press;
    if (!current || event.pointerId !== current.id) return;
    if (!current.dragging) {
      if (!claims(current, event.clientX, event.clientY)) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        press = undefined;
        return;
      }
      begin(current);
    }
    const raw = current.from + (event.clientY - current.y);
    apply(raw >= 0 ? raw : -rubberband(-raw, current.stretch));
    current.samples.push({ t: event.timeStamp, y: raw });
    if (current.samples.length > 32) current.samples.shift();
  };

  const onPointerEnd = (event: PointerEvent) => {
    const current = press;
    if (!current || event.pointerId !== current.id) return;
    press = undefined;
    if (!current.dragging) return;
    if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
    const recent = current.samples.at(-1);
    const still = !recent || event.timeStamp - recent.t > WINDOW_MS / 2;
    release(event.type === "pointercancel" || still ? 0 : velocityOf(current.samples));
  };

  // A finger the sheet takes moves only the sheet. The browser commits to scrolling on the first
  // move it is not stopped on, so the content's fate is settled by then.
  const onTouchMove = (event: TouchEvent) => {
    const current = press;
    const touch = event.touches[0];
    if (!current || !touch) return;
    if (current.dragging || claims(current, touch.clientX, touch.clientY)) event.preventDefault();
  };

  // A press is followed on the window: before the drag takes the pointer, the first moves can
  // already be off the sheet (dragging up from its top edge).
  panel.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerEnd);
  window.addEventListener("pointercancel", onPointerEnd);
  panel.addEventListener("touchmove", onTouchMove, { passive: false });
  return () => {
    cancelAnimationFrame(frame);
    if (host.presentation) settle();
    panel.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerEnd);
    window.removeEventListener("pointercancel", onPointerEnd);
    panel.removeEventListener("touchmove", onTouchMove);
  };
}
