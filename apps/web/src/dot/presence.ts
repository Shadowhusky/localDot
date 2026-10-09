import type { Point } from "./engine/engine.ts";
import type { DotState } from "./engine/states.ts";
import { type Box, Flight } from "./flight.ts";
import { gazeTo } from "./gaze.ts";
import { placeElement } from "./places.ts";
import type { PresencePlace } from "./presence-rules.ts";
import { DotView } from "./render/DotView.ts";
import { now } from "./render/scheduler.ts";

const FADE_MS = 150;
// Idle wander leans this far toward the stage's centre.
const BIAS_SHARE = 0.75;

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
  private place: PresencePlace | null = null;
  private drawn = 0;
  private raf = 0;
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
    const t = now();
    const current = this.flight.at(t);
    this.view.hop();
    this.frame.dataset.flying = "";
    this.draw(Math.max(current.size, box.size));
    this.flight.fly(box, t, from === "badge");
    this.run();
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
    if (resized && !this.raf) {
      this.land(box);
      return;
    }
    this.draw(Math.max(this.drawn, box.size));
    this.flight.follow(box, now());
    this.run();
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
    cancelAnimationFrame(this.raf);
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

  private position(box: Box): void {
    const k = box.size / this.drawn;
    this.frame.style.transform = `translate3d(${box.x.toFixed(2)}px, ${box.y.toFixed(2)}px, 0) scale(${k.toFixed(4)})`;
  }

  private land(box: Box): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.flight) this.flight.jump(box, now());
    else this.flight = new Flight(box);
    this.draw(box.size);
    this.position(box);
    delete this.frame.dataset.flying;
    this.settled();
  }

  private run(): void {
    if (this.raf) return;
    const tick = () => {
      this.raf = 0;
      if (!this.flight) return;
      const box = this.flight.at(now());
      if (box.settled) {
        this.land(box);
        return;
      }
      this.position(box);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
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
