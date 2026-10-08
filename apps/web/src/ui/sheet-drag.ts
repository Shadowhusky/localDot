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

export function releaseTo(offset: number, velocity: number, height: number): "dismiss" | "rest" {
  return offset + project(velocity) > height * DISMISS_AT ? "dismiss" : "rest";
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
  // The one scroller inside: a drag starts there only from its top, moving down.
  body: HTMLElement | null;
  // Says whether the sheet may close. A sheet with unsaved changes asks first and stays.
  allowDismiss(): boolean;
  close(): void;
  reducedMotion(): boolean;
}

interface Press {
  id: number;
  x: number;
  y: number;
  fromBody: boolean;
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
  const { panel, scrim, body } = host;
  let press: Press | undefined;
  let offset = 0;
  let frame = 0;

  const apply = (value: number) => {
    offset = value;
    const height = panel.offsetHeight || 1;
    panel.style.translate = `0 ${value}px`;
    if (scrim) scrim.style.opacity = `${Math.min(1, Math.max(0, 1 - value / height))}`;
  };

  const settle = () => {
    panel.style.removeProperty("transition");
    panel.style.removeProperty("translate");
    scrim?.style.removeProperty("transition");
    scrim?.style.removeProperty("opacity");
    offset = 0;
  };

  const presented = (): number => {
    const value = getComputedStyle(panel).translate;
    const y = value === "none" ? 0 : Number.parseFloat(value.split(" ")[1] ?? "0");
    return Number.isFinite(y) ? y : 0;
  };

  const animate = (to: number, velocity: number, done: () => void) => {
    const from = offset;
    const params = Math.abs(velocity) >= FLICK_SPEED ? FLICK : SETTLE;
    const start = performance.now();
    const step = (now: number) => {
      const t = (now - start) / 1000;
      const value = springValue(from, to, velocity, t, params);
      const speed = (springValue(from, to, velocity, t + 0.001, params) - value) / 0.001;
      apply(value);
      const offscreen = to > 0 && value >= to;
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
    const decision = offset > 0 ? releaseTo(offset, velocity, height) : "rest";
    if (decision === "dismiss" && host.allowDismiss()) {
      if (host.reducedMotion()) {
        // The sheet fades where it is instead of travelling.
        panel.style.removeProperty("transition");
        scrim?.style.removeProperty("transition");
        scrim?.style.removeProperty("opacity");
        host.close();
        return;
      }
      animate(height, velocity, () => {
        scrim?.style.removeProperty("opacity");
        scrim?.style.removeProperty("transition");
        host.close();
      });
      return;
    }
    if (host.reducedMotion()) return settle();
    animate(0, velocity, settle);
  };

  const begin = (event: PointerEvent, current: Press) => {
    current.dragging = true;
    cancelAnimationFrame(frame);
    frame = 0;
    panel.setPointerCapture(event.pointerId);
    panel.style.transition = "none";
    if (scrim) scrim.style.transition = "none";
  };

  const onPointerDown = (event: PointerEvent) => {
    if (press || (event.pointerType === "mouse" && event.button !== 0)) return;
    const target = event.target instanceof Element ? event.target : null;
    const inHandle = Boolean(target?.closest(".ui-sheet-handle"));
    const fromBody = Boolean(body && target && body.contains(target));
    if (!inHandle && !fromBody) return;
    if (!inHandle && (event.pointerType === "mouse" || (body?.scrollTop ?? 0) > 0)) return;
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      fromBody,
      dragging: false,
      from: frame ? offset : presented(),
      stretch: Number.parseFloat(getComputedStyle(panel).paddingBottom) || 1,
      samples: [],
    };
    // A sheet still springing is caught at once, wherever it is.
    if (frame) begin(event, press);
  };

  const onPointerMove = (event: PointerEvent) => {
    const current = press;
    if (!current || event.pointerId !== current.id) return;
    if (!current.dragging) {
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (Math.abs(dx) > Math.abs(dy) || (current.fromBody && dy < 0)) {
        press = undefined;
        return;
      }
      begin(event, current);
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

  // A drag that starts in the scroller would otherwise also pull at the page.
  const onTouchMove = (event: TouchEvent) => {
    if (press?.dragging || (press?.fromBody && (body?.scrollTop ?? 0) <= 0)) {
      const touch = event.touches[0];
      if (press.dragging || (touch && touch.clientY > press.y)) event.preventDefault();
    }
  };

  // A press is followed on the window: before the drag takes the pointer, the first moves can
  // already be off the sheet (dragging up from its top edge).
  panel.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerEnd);
  window.addEventListener("pointercancel", onPointerEnd);
  body?.addEventListener("touchmove", onTouchMove, { passive: false });
  return () => {
    cancelAnimationFrame(frame);
    panel.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerEnd);
    window.removeEventListener("pointercancel", onPointerEnd);
    body?.removeEventListener("touchmove", onTouchMove);
  };
}
