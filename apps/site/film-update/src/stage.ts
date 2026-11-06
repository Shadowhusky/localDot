import type { Wearable } from "@localdot/protocol";
import {
  type DirectionalLight,
  type Group,
  NeutralToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { Dot3D } from "../../src/dot3d/dot3d.ts";
import { perspectiveTip } from "../../src/dot3d/face.ts";
import { centreRig, studioLight, studioLights } from "../../src/dot3d/rig.ts";
import { loadWardrobe } from "../../src/dot3d/wardrobe.ts";
import { blockAt, type Place } from "./blocking.ts";
import { M } from "./cues.ts";
import {
  askAround,
  type Camera,
  CREW,
  cameraAt,
  cardAround,
  chatShown,
  direction,
  expandAt,
  growAt,
  heldAround,
  type Layout,
  lightAt,
  type Rect,
  rectToFrame,
  SCREENS,
  type Shot,
  screenOn,
  shotToFrame,
  shrinkAt,
  sparkAt,
  stageHeld,
  type Takes,
  type Touch,
  toFrame,
  touchAt,
  windowAt,
} from "./layout.ts";
import { crewScript, type Input, mainScript } from "./script.ts";

// The film's frame, and the site's camera: 30 degrees, the plane two units tall at its distance.
const FOV = 30;
const TAN = Math.tan((FOV * Math.PI) / 360);
const D = 1 / TAN;
// How far a dot stands from the camera, in world units.
const FREE = 6;
// Room round an element the spotlight leaves lit, in frame pixels.
const PAD = 12;

interface Actor {
  dot: Dot3D;
  scripts: readonly (readonly Input[])[];
  done: number[];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const between = (a: Rect, b: Rect, u: number): Rect => ({
  x: a.x + (b.x - a.x) * u,
  y: a.y + (b.y - a.y) * u,
  w: a.w + (b.w - a.w) * u,
  h: a.h + (b.h - a.h) * u,
});

function fade(el: HTMLElement, opacity: number): void {
  el.style.visibility = opacity > 0 ? "inherit" : "hidden";
  el.style.opacity = opacity.toFixed(3);
}

// A picture on its way from one rect of the phone's screen to another, or none.
function carry(
  el: HTMLElement,
  u: number | null,
  from: Rect,
  to: Rect,
  radius: readonly [number, number],
  opacity: number,
): void {
  fade(el, u === null ? 0 : opacity);
  if (u === null) return;
  const r = between(from, to, u);
  Object.assign(el.style, {
    left: `${r.x.toFixed(2)}px`,
    top: `${r.y.toFixed(2)}px`,
    width: `${r.w.toFixed(2)}px`,
    height: `${r.h.toFixed(2)}px`,
    borderRadius: `${(radius[0] + (radius[1] - radius[0]) * u).toFixed(2)}px`,
  });
}

// Places a screen at its shot, at the opacity it has now.
function placeAt(el: HTMLElement, shot: Shot, w: number, h: number, opacity: number): void {
  el.style.visibility = opacity > 0.002 ? "visible" : "hidden";
  el.style.opacity = opacity.toFixed(3);
  const x = shot.cx - w / 2;
  const y = shot.cy - h / 2;
  el.style.transform = `translate3d(${x.toFixed(3)}px, ${y.toFixed(3)}px, 0) scale(${shot.s.toFixed(5)})`;
}

export class UpdateStage {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly actors: Actor[];
  private readonly rig: Group;
  private ms = 0;
  private last = Number.POSITIVE_INFINITY;
  private readonly screens: readonly (readonly [HTMLElement, number, number])[];
  private readonly sparks: readonly {
    el: HTMLElement;
    at: number;
    x: number;
    y: number;
    i: number;
  }[];
  private readonly plan: ReturnType<typeof direction>;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly els: {
      canvas: HTMLCanvasElement;
      world: HTMLElement;
      chat: HTMLElement;
      // Studio's window first, then the others in the order they arrive.
      windows: readonly HTMLElement[];
      touch: HTMLElement;
      ask: HTMLElement;
      held: HTMLElement;
      heldStage: HTMLElement;
      card: HTMLElement;
      tab: HTMLElement;
      grow: HTMLElement;
      shrink: HTMLElement;
      spot: SVGSVGElement;
      spark: () => HTMLElement;
    },
    private readonly touches: readonly Touch[],
    private readonly takes: Takes,
    private readonly layout: Layout,
  ) {
    this.plan = direction(layout, takes);
    this.screens = SCREENS.map(
      ([id, from, to]) => [document.getElementById(id) as HTMLElement, from, to] as const,
    );
    this.sparks = layout.sparks.map(([x, y], i) => ({ el: els.spark(), at: M.hit, x, y, i }));
    this.camera = new PerspectiveCamera(FOV, layout.W / layout.H, 0.05, 200);
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(2);
    this.renderer.setSize(layout.W, layout.H, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.scene.environment = studioLight(this.renderer).texture;
    const now = () => this.ms;
    const actor = (seed: number, scripts: readonly (readonly Input[])[], shadow = false): Actor => {
      const dot = new Dot3D({ seed, now, contactShadow: shadow });
      this.scene.add(dot.group);
      return { dot, scripts, done: scripts.map(() => 0) };
    };
    // dot, and each window's own, with a soft shadow on its window.
    this.actors = [
      actor(7, [mainScript(layout)]),
      ...CREW.map((_, i) => actor(20 + i, [crewScript(i)], true)),
    ];
    this.rig = studioLights();
    for (const light of this.rig.children)
      if ("target" in light)
        (light as DirectionalLight).target = (this.actors[0] as Actor).dot.group;
    this.camera.add(this.rig);
    this.scene.add(this.camera);
    this.camera.position.set(0, 0, D);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
  }

  async ready(): Promise<void> {
    await loadWardrobe();
  }

  renderAt(seconds: number): void {
    const t = Math.max(0, seconds);
    this.drive(t);
    const view = cameraAt(t, this.plan.base, this.plan.keys);
    this.placeScreens(t, view);
    this.placeMarks(t);
    this.placeLight(t, view);
    const { main, crew } = blockAt(t, this.layout);
    this.placeDot(0, main);
    // Each window's dot sits on its window's top edge, no larger on screen than a dot that reads as one
    // of many.
    const most = this.layout.dot;
    crew.forEach((place, i) => {
      const [x, y] = toFrame(view, place.x, place.y);
      const r = Math.min(place.r * view.k, most);
      this.placeDot(i + 1, { ...place, x, y: y - r * 0.8, r });
    });
    // Over the windows once the phone has gone, so the dots sit on them; under the world before, where
    // the phone's own words are.
    const { canvas, world } = this.els;
    if (t >= M.desk + 0.5) world.after(canvas);
    else world.before(canvas);
    this.renderer.render(this.scene, this.camera);
  }

  private placeScreens(t: number, view: Camera): void {
    const { world, chat, windows } = this.els;
    const { layout } = this;
    placeAt(chat, shotToFrame(view, layout.chat), layout.chat.w, layout.chat.h, chatShown(t));
    for (const [el, from, to] of this.screens)
      el.style.visibility = screenOn(t, from, to) ? "inherit" : "hidden";
    this.placeMoves(t);
    // Studio's window and the others, each its cell of the grid, the size of its own take.
    windows.forEach((el, n) => {
      const at = windowAt(t, layout, n - 1);
      const { w, h } = n === 0 ? layout.room : layout.window;
      const fit = layout.grid.w / w;
      placeAt(
        el,
        shotToFrame(view, { cx: at?.x ?? 0, cy: at?.y ?? 0, s: fit * (at?.scale ?? 1) }),
        w,
        h,
        at?.opacity ?? 0,
      );
    });
    // In close, the world shows only through the band below the titles.
    const close = this.plan.closeness(view);
    let mask = "none";
    if (close > 0.001) {
      const top = layout.band.top * close;
      const bottom = layout.H - (layout.H - layout.band.bottom) * close;
      mask = `linear-gradient(to bottom, transparent ${(top - 24).toFixed(1)}px, #000 ${top.toFixed(1)}px, #000 ${bottom.toFixed(1)}px, transparent ${(bottom + 24).toFixed(1)}px)`;
    }
    world.style.maskImage = mask;
    world.style.setProperty("-webkit-mask-image", mask);
  }

  // The pictures carried from place to place on the phone, and the screens round them.
  private placeMoves(t: number): void {
    const { grow, shrink, ask, held, heldStage, card, tab } = this.els;
    const { thumbPicture, stagePicture, card: cardRect } = this.takes;
    ask.style.opacity = askAround(t).toFixed(3);
    fade(held, heldAround(t));
    fade(heldStage, stageHeld(t));
    card.style.opacity = cardAround(t).toFixed(3);
    carry(grow, growAt(t), thumbPicture, stagePicture, [8, 14], 1);
    const u = shrinkAt(t);
    carry(
      shrink,
      u,
      stagePicture,
      cardRect,
      [14, 12],
      u === null ? 0 : 1 - clamp01((u - 0.7) / 0.3),
    );
    // The card opens into the tab: the tab shows through it, and it grows to the whole screen.
    const e = expandAt(t);
    const { w, h } = this.layout.chat;
    const r = e === null ? null : between(cardRect, { x: 0, y: 0, w, h }, e);
    tab.style.clipPath = r
      ? `inset(${r.y.toFixed(2)}px ${(w - r.x - r.w).toFixed(2)}px ${(h - r.y - r.h).toFixed(2)}px ${r.x.toFixed(2)}px round ${(12 * (1 - (e ?? 0))).toFixed(2)}px)`
      : "none";
  }

  // The fingertip and the sparkles: each is hidden until it has its place at that frame,
  // so none can show at the corner they start from.
  private placeMarks(t: number): void {
    const { touch } = this.els;
    const tip = touchAt(t, this.touches);
    touch.style.visibility = tip ? "visible" : "hidden";
    if (tip) {
      touch.style.opacity = tip.opacity.toFixed(3);
      touch.style.transform = `translate3d(${(tip.x - 24).toFixed(2)}px, ${(tip.y - 24).toFixed(2)}px, 0) scale(${tip.scale.toFixed(3)})`;
    }
    for (const { el, at, x, y, i } of this.sparks) {
      const spark = sparkAt(t, at, i);
      el.style.visibility = spark ? "visible" : "hidden";
      if (spark) {
        el.style.opacity = spark.opacity.toFixed(3);
        el.style.transform = `translate3d(${x - 16}px, ${y - 16}px, 0) rotate(${spark.rotation.toFixed(1)}deg) scale(${spark.scale.toFixed(3)})`;
      }
    }
  }

  // The spotlight: the frame dims round the element that proves the feature, and a ring marks it.
  private placeLight(t: number, view: Camera): void {
    const { spot } = this.els;
    const light = this.plan.lights.find((one) => lightAt(t, one) > 0.002);
    spot.style.visibility = light ? "visible" : "hidden";
    if (!light) return;
    spot.style.opacity = lightAt(t, light).toFixed(3);
    spot.querySelectorAll<SVGRectElement>(".ring").forEach((ring, i) => {
      const area = light.rects[i];
      ring.style.display = area ? "" : "none";
      if (!area) return;
      const r = rectToFrame(view, area);
      ring.setAttribute("x", (r.x - PAD).toFixed(1));
      ring.setAttribute("y", (r.y - PAD).toFixed(1));
      ring.setAttribute("width", (r.w + 2 * PAD).toFixed(1));
      ring.setAttribute("height", (r.h + 2 * PAD).toFixed(1));
    });
  }

  private drive(t: number): void {
    if (t < this.last) {
      this.ms = 0;
      for (const actor of this.actors) {
        actor.dot.restart();
        actor.done = actor.scripts.map(() => 0);
      }
    }
    this.last = t;
    for (const actor of this.actors)
      actor.scripts.forEach((script, i) => {
        let next = actor.done[i] as number;
        for (let input = script[next]; input && input[0] <= t; input = script[++next]) {
          this.ms = input[0] * 1000;
          input[1](actor.dot);
        }
        actor.done[i] = next;
      });
    this.ms = t * 1000;
  }

  private placeDot(i: number, place: Place): void {
    const { dot } = this.actors[i] as Actor;
    dot.group.visible = place.shown;
    if (!place.shown) return;
    const position = this.atFrame(place.x, place.y, FREE);
    const radius = place.r * this.worldPerPx(FREE);
    dot.group.position.copy(position);
    dot.group.position.y -= radius * place.squash;
    dot.group.scale.set(
      radius * (1 + place.squash * 0.5),
      radius * (1 - place.squash),
      radius * (1 + place.squash * 0.5),
    );
    dot.group.lookAt(this.camera.position);
    dot.tip = perspectiveTip(radius, this.camera.position.distanceTo(position));
    dot.spin = place.spin;
    dot.wear(place.wears as readonly Wearable[]);
    if (i === 0) centreRig(this.rig, this.camera, position);
    dot.update((radius / this.worldPerPx(this.camera.position.distanceTo(position))) * 2);
  }

  private atFrame(x: number, y: number, distance: number): Vector3 {
    const ray = new Vector3((x / this.layout.W) * 2 - 1, 1 - (y / this.layout.H) * 2, 0.5)
      .unproject(this.camera)
      .sub(this.camera.position);
    return this.camera.position.clone().add(ray.normalize().multiplyScalar(distance));
  }

  private worldPerPx(distance: number): number {
    return (2 * distance * TAN) / this.layout.H;
  }
}
