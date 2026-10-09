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

const sameBox = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && a.size === b.size;

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

// The one live dot, moved between the places that keep room for it. At rest it sits inside its place,
// so a scroll, a drag or a bounce that moves the place moves dot with it in the same frame; it flies
// in a fixed layer over the page. Its DotView is made once, so its engine never restarts when it
// changes places.
export class Presence {
  readonly view: DotView;
  private readonly frame: HTMLElement;
  private readonly host: HTMLElement;
  // The fixed layer dot flies in, where its frame starts.
  private readonly layer: HTMLElement;
  // The place dot rests in, which carries it.
  private home: HTMLElement | null = null;
  private flight: Flight | null = null;
  private motion: Animation | null = null;
  private place: PresencePlace | null = null;
  // Put away because its place had no box to draw it over.
  private lost = false;
  private drawn = 0;
  private fade: ReturnType<typeof setTimeout> | undefined;
  private reduced: boolean;
  private focus: Point | null = null;
  // Tells dot when its place is laid out, hidden or resized, which moves no scroll or resize event.
  private readonly sizes =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => this.follow(false)) : null;
  private watched: Element | null = null;

  constructor(frame: HTMLElement, host: HTMLElement, o: PresenceOptions) {
    this.frame = frame;
    this.host = host;
    this.layer = frame.parentElement ?? document.body;
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
    const element = place && placeElement(place);
    this.watch(element);
    const box = boxOf(element);
    if (!box) {
      this.lost = place !== null;
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
        this.fade = undefined;
        const at = this.place && boxOf(placeElement(this.place));
        if (!at) {
          this.lost = this.place !== null;
          return;
        }
        this.land(at);
        this.show(true);
      }, FADE_MS);
      return;
    }
    const t = frameTime();
    this.leave(t);
    const current = this.flight.at(t);
    // One flight at a time: a new place mid-flight bends the path, with no second take-off.
    if (current.settled) this.view.hop();
    this.frame.dataset.flying = "";
    this.draw(Math.max(current.size, box.size));
    this.flight.fly(box, t, from === "badge");
    this.animate(t);
  }

  // The place changed under dot. Resting in it, dot has already moved with it and only takes on its
  // size; flying, or given a new box for the same place, it turns toward where the place is now. A
  // window resize lands it there, and a dot put away while its place had no box comes back at once.
  follow(resized: boolean): void {
    const element = this.place && placeElement(this.place);
    this.watch(element);
    const box = boxOf(element);
    if (!box || this.fade !== undefined) return;
    if (this.lost) {
      this.land(box);
      this.show(true);
      return;
    }
    if (!this.flight) return;
    if (element === this.home) {
      this.draw(box.size);
      this.flight.jump(box, frameTime());
      return;
    }
    if (sameBox(box, this.flight.target)) {
      if (this.home) this.land(box);
      return;
    }
    if (resized && !this.motion) {
      this.land(box);
      return;
    }
    const t = frameTime();
    this.leave(t);
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
    this.sizes?.disconnect();
    this.layer.append(this.frame);
    this.view.destroy();
  }

  private watch(element: Element | null): void {
    if (element === this.watched) return;
    this.sizes?.disconnect();
    this.watched = element;
    if (element) this.sizes?.observe(element);
  }

  private show(on: boolean): void {
    if (!on) {
      delete this.frame.dataset.shown;
      return;
    }
    if (this.frame.dataset.shown !== undefined) return;
    // A frame that has just moved into its place has no style yet for the fade to start from.
    void this.frame.offsetWidth;
    this.frame.dataset.shown = "";
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
    this.lost = false;
    if (this.flight) this.flight.jump(box, frameTime());
    else this.flight = new Flight(box);
    this.draw(box.size);
    // dot moves into its place before the flight lets go, so no frame falls between them.
    const home = this.place && placeElement(this.place);
    if (home && boxOf(home)) {
      home.append(this.frame);
      this.frame.style.transform = "";
      this.home = home;
    } else {
      this.layer.append(this.frame);
      this.frame.style.transform = this.transform(box);
      this.home = null;
    }
    this.motion?.cancel();
    this.motion = null;
    delete this.frame.dataset.flying;
    this.settled();
  }

  // Out of its place into the layer, from where the page has carried it; from where it last rested
  // when the place has gone or is hidden.
  private leave(t: number): void {
    if (!this.home || !this.flight) return;
    const box = boxOf(this.frame) ?? this.flight.target;
    this.home = null;
    this.flight.jump(box, t);
    this.frame.style.transform = this.transform(box);
    this.layer.append(this.frame);
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
        if (this.motion !== motion) return;
        // The place moved while dot flew, as in a scroll: it turns to where the place is, then lands.
        const box = this.place && boxOf(placeElement(this.place));
        if (box && !sameBox(box, flight.target)) this.follow(false);
        else this.land(flight.target);
      },
      () => {},
    );
  }

  private centre(): Point | null {
    const at = (this.home && boxOf(this.frame)) || this.flight?.target;
    return at ? { x: at.x + at.size / 2, y: at.y + at.size / 2 } : null;
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
