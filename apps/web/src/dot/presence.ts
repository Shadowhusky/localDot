import type { Point } from "./engine/engine.ts";
import type { DotState } from "./engine/states.ts";
import { type Box, Flight } from "./flight.ts";
import { gazeTo } from "./gaze.ts";
import { placeElement } from "./places.ts";
import type { PresencePlace } from "./presence-rules.ts";
import { DotView } from "./render/DotView.ts";

const FADE_MS = 150;
// Idle wander leans this far toward the stage's centre.
const BIAS_SHARE = 0.75;
// A flight is drawn ahead at this step and handed to the compositor, so a busy page never stalls it.
const STEP_MS = 1000 / 60;
const LONGEST_FLIGHT_MS = 3000;

// The frame time the compositor draws animations at, which flights share so a new one starts
// exactly where the last one is on screen.
function frameTime(): number {
  const t = document.timeline?.currentTime;
  return typeof t === "number" ? t : performance.now();
}

function boxOf(element: Element | null): Box | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return { x: rect.left, y: rect.top, size: Math.round(rect.width) };
}

function centreOf(element: Element | null): Point | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
}

export interface PresenceOptions {
  state: DotState;
  control: boolean;
  reducedMotion: boolean;
}

// The one live dot, drawn in a fixed layer over the page and moved between the places that keep
// room for it. Its DotView is made once, so its engine never restarts when it changes places.
export class Presence {
  readonly view: DotView;
  private readonly frame: HTMLElement;
  private readonly host: HTMLElement;
  private flight: Flight | null = null;
  private motion: Animation | null = null;
  private place: PresencePlace | null = null;
  private drawn = 0;
  private fade: ReturnType<typeof setTimeout> | undefined;
  private reduced: boolean;
  private focus: Point | null = null;

  constructor(frame: HTMLElement, host: HTMLElement, o: PresenceOptions) {
    this.frame = frame;
    this.host = host;
    this.reduced = o.reducedMotion;
    this.view = new DotView(host, { size: 96, ...o });
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on;
    this.view.setReducedMotion(on);
  }

  goTo(place: PresencePlace | null): void {
    const from = this.place;
    this.place = place;
    const box = place && boxOf(placeElement(place));
    if (!box) {
      this.show(false);
      return;
    }
    if (!this.flight || from === null || this.frame.dataset.shown === undefined) {
      this.land(box);
      this.show(true);
      return;
    }
    if (from === place) {
      this.follow(false);
      return;
    }
    if (this.reduced) {
      // No flight: a fade out where dot is, a jump, then a fade in at its new place.
      this.show(false);
      clearTimeout(this.fade);
      this.fade = setTimeout(() => {
        const at = this.place && boxOf(placeElement(this.place));
        if (!at) return;
        this.land(at);
        this.show(true);
      }, FADE_MS);
      return;
    }
    const t = frameTime();
    const current = this.flight.at(t);
    // One flight at a time: a new place mid-flight bends the path, with no second take-off.
    if (current.settled) this.view.hop();
    this.frame.dataset.flying = "";
    this.draw(Math.max(current.size, box.size));
    this.flight.fly(box, t, from === "badge");
    this.animate(t);
  }

  // The place moved under dot: a window resize lands it there, anything else is followed.
  follow(resized: boolean): void {
    const box = this.place && boxOf(placeElement(this.place));
    if (!box || !this.flight) return;
    const target = this.flight.target;
    if (
      Math.abs(box.x - target.x) < 0.5 &&
      Math.abs(box.y - target.y) < 0.5 &&
      box.size === target.size
    )
      return;
    if (resized && !this.motion) {
      this.land(box);
      return;
    }
    const t = frameTime();
    this.draw(Math.max(this.drawn, box.size));
    this.flight.follow(box, t);
    this.animate(t);
  }

  // The action point on the stage, as fractions of its width and height.
  setFocus(focus: Point | null): void {
    this.focus = focus;
    this.aim();
  }

  // The composer's centre on the page, while the user types to dot.
  lookAtComposer(at: Point): void {
    const me = this.centre();
    if (me) this.view.setPlaces({ composer: gazeTo(at.x - me.x, at.y - me.y) });
  }

  destroy(): void {
    this.motion?.cancel();
    clearTimeout(this.fade);
    this.view.destroy();
  }

  private show(on: boolean): void {
    if (on) this.frame.dataset.shown = "";
    else delete this.frame.dataset.shown;
  }

  private draw(size: number): void {
    if (size === this.drawn) return;
    this.drawn = size;
    this.host.style.setProperty("--dot-size", `${size}px`);
    this.frame.style.setProperty("--frame", `${size}px`);
    this.view.setSize(size);
  }

  private transform(box: Box): string {
    const k = box.size / this.drawn;
    return `translate3d(${box.x.toFixed(2)}px, ${box.y.toFixed(2)}px, 0) scale(${k.toFixed(4)})`;
  }

  private land(box: Box): void {
    if (this.flight) this.flight.jump(box, frameTime());
    else this.flight = new Flight(box);
    this.draw(box.size);
    // The resting place is written before the flight lets go, so no frame falls between them.
    this.frame.style.transform = this.transform(box);
    this.motion?.cancel();
    this.motion = null;
    delete this.frame.dataset.flying;
    this.settled();
  }

  // Replaces the flight on screen with the one from t on. The new one starts at the frame the last
  // one is drawn at, from the same place and speed, so the switch can't be seen.
  private animate(t: number): void {
    const flight = this.flight;
    if (!flight) return;
    const frames: Keyframe[] = [];
    let at = t;
    for (let box = flight.at(at); !box.settled && at - t < LONGEST_FLIGHT_MS; box = flight.at(at)) {
      frames.push({ transform: this.transform(box) });
      at += STEP_MS;
    }
    if (!frames.length || typeof this.frame.animate !== "function") {
      this.land(flight.target);
      return;
    }
    frames.push({ transform: this.transform(flight.target) });
    this.motion?.cancel();
    const motion = this.frame.animate(frames, {
      duration: at - t,
      easing: "linear",
      fill: "forwards",
    });
    motion.startTime = t;
    this.motion = motion;
    motion.finished.then(
      () => {
        if (this.motion === motion) this.land(flight.target);
      },
      () => {},
    );
  }

  private centre(): Point | null {
    const target = this.flight?.target;
    return target ? { x: target.x + target.size / 2, y: target.y + target.size / 2 } : null;
  }

  // Once dot sits still: where its idle eyes rest, where the decision is, and where its work is.
  private settled(): void {
    const me = this.centre();
    const stage = centreOf(placeElement("stage"));
    if (!me) return;
    if (this.place === "dock" && stage) {
      const g = gazeTo(stage.x - me.x, stage.y - me.y);
      this.view.setBias({ x: g.x * BIAS_SHARE, y: g.y * BIAS_SHARE });
    }
    const island = centreOf(document.querySelector(".island"));
    if (island) this.view.setPlaces({ card: gazeTo(island.x - me.x, island.y - me.y) });
    this.aim();
  }

  private aim(): void {
    const me = this.centre();
    const stage = placeElement("stage")?.getBoundingClientRect();
    if (!this.focus || !me || !stage || this.place === "hero" || this.place === "intro") {
      this.view.setFocus(null);
      return;
    }
    const x = stage.left + this.focus.x * stage.width;
    const y = stage.top + this.focus.y * stage.height;
    this.view.setFocus(gazeTo(x - me.x, y - me.y));
  }
}
