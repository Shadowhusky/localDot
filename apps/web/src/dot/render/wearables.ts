import type { Wearable } from "@localdot/protocol";
import { afterMotion } from "../../ui/finished.ts";
import type { DotPose } from "../engine/engine.ts";
import { clamp } from "../engine/math.ts";
import { eyeFrame } from "../engine/sphere.ts";
import { WEAR_PLATES, whenImagesIn } from "../plates.ts";

type Place = readonly [number, number];

// Where on the face a wearable sits, in frame units from the body's centre. It turns with the face
// as the eyes do.
const FACE: Partial<Record<Wearable, Place>> = {
  "round-glasses": [0, -4.5],
  sunglasses: [0, -4.5],
  mustache: [0, 6],
  monocle: [5.5, -4.5],
  "heart-glasses": [0, -4.5],
  "clown-nose": [0, 5],
  blush: [0, 4],
};

// What sits on the head turns with the face about the point where its front meets the head, by a
// share of the turn across and up: its plate shows it from the front, and the whole turn would carry
// its far side off the ball's outline. Clothes and the pin stay with the body, which a turn of the
// sphere leaves where it was, and follow only the face's roll about the centre.
interface Mount {
  pivot: Place;
  follow: Place;
  // How far its plate rises above the top of the ball, in frame units.
  crown: number;
}
const HEAD: Partial<Record<Wearable, Mount>> = {
  cap: { pivot: [0, -15], follow: [0.5, 1], crown: 5 },
  beret: { pivot: [-2, -18], follow: [0.5, 1], crown: 4.25 },
  mortarboard: { pivot: [0, -14], follow: [0.5, 1], crown: 7.5 },
  // The cups sit on the outline, where a turn only carries them round the back.
  headphones: { pivot: [0, -21], follow: [0.2, 0.4], crown: 1.5 },
  bow: { pivot: [-11, -17], follow: [0.6, 1], crown: 3 },
  beanie: { pivot: [0, -13], follow: [0.5, 1], crown: 7.5 },
  "party-hat": { pivot: [-11, -17], follow: [0.6, 1], crown: 7 },
  crown: { pivot: [0, -17], follow: [0.5, 1], crown: 7 },
  "wizard-hat": { pivot: [0, -18], follow: [0.5, 1], crown: 7.5 },
  "top-hat": { pivot: [-5, -20], follow: [0.6, 1], crown: 7 },
  "chef-hat": { pivot: [0, -16], follow: [0.5, 1], crown: 7 },
  "hard-hat": { pivot: [0, -15], follow: [0.5, 1], crown: 5 },
  sprout: { pivot: [0, -23], follow: [0.8, 1], crown: 7 },
  "flower-crown": { pivot: [0, -18], follow: [0.6, 1], crown: 0 },
  antenna: { pivot: [-6, -22], follow: [0.8, 1], crown: 7.5 },
  // They grow from behind the outline, where a turn only carries them round the back.
  "cat-ears": { pivot: [0, -19], follow: [0.15, 0.25], crown: 6 },
  halo: { pivot: [0, -23], follow: [0.8, 1], crown: 7.5 },
  "viking-helmet": { pivot: [0, -15], follow: [0.5, 1], crown: 5.5 },
  "cowboy-hat": { pivot: [0, -15], follow: [0.5, 1], crown: 7 },
  "propeller-cap": { pivot: [0, -15], follow: [0.5, 1], crown: 7.5 },
  headband: { pivot: [0, -14], follow: [0.5, 1], crown: 0 },
};

// How far what dot wears on its head rises above the ball, in frame units, so a place with
// something just above it can keep the gap a bare head has.
export function crown(list: readonly Wearable[]): number {
  return Math.max(0, ...list.map((name) => HEAD[name]?.crown ?? 0));
}
// The most a turn tilts or foreshortens what the head wears; past this a plate reads as warped.
const STRETCH = 0.08;

// Back to front: clothes; hats; what sits on those; and what is on the face.
const LAYER: Record<Wearable, number> = {
  suit: 1,
  scarf: 1,
  hoodie: 1,
  "striped-tee": 1,
  overalls: 1,
  cap: 2,
  beret: 2,
  mortarboard: 2,
  headphones: 2,
  beanie: 2,
  "party-hat": 2,
  crown: 2,
  "wizard-hat": 2,
  "top-hat": 2,
  "chef-hat": 2,
  "hard-hat": 2,
  sprout: 2,
  "flower-crown": 2,
  antenna: 2,
  "cat-ears": 2,
  halo: 2,
  "viking-helmet": 2,
  "cowboy-hat": 2,
  "propeller-cap": 2,
  headband: 2,
  bow: 3,
  "star-pin": 3,
  "bow-tie": 3,
  medal: 3,
  pearls: 3,
  lei: 3,
  blush: 4,
  "round-glasses": 4,
  sunglasses: 4,
  mustache: 4,
  monocle: 4,
  "heart-glasses": 4,
  "clown-nose": 4,
};

// What is worn, back to front.
export const wornInOrder = (list: readonly Wearable[]): Wearable[] =>
  [...list].sort((a, b) => LAYER[a] - LAYER[b]);

// Eyewear is drawn round the eye's true size, so behind it the eye keeps that size and doesn't grow
// to read when small or to show surprise.
const EYEWEAR: ReadonlySet<Wearable> = new Set([
  "sunglasses",
  "round-glasses",
  "monocle",
  "heart-glasses",
]);

export const eyeScaleLimit = (list: readonly Wearable[]) =>
  list.some((name) => EYEWEAR.has(name)) ? 1 : Number.POSITIVE_INFINITY;

// The wearables are rendered under the neutral light; the dim plate keeps this much of it.
const DIM_LIGHT = 0.3;

// What of a pose places a plate.
export type FaceTurn = Pick<DotPose, "gaze" | "roll">;

interface Worn {
  name: Wearable;
  img: HTMLImageElement;
  transform: string;
  filter: string;
}

const num = (v: number, digits: number) => (Math.abs(v) < 10 ** -digits ? "0" : v.toFixed(digits));

// The point a plate turns about, in frame units from the body's centre; clothes turn about the centre.
export const platePivot = (name: Wearable): Place => FACE[name] ?? HEAD[name]?.pivot ?? [0, 0];

export function plateOrigin(name: Wearable): string {
  const [x, y] = platePivot(name);
  return `${((32 + x) / 64) * 100}% ${((32 + y) / 64) * 100}%`;
}

// How a plate sits in a pose; k is CSS px per frame unit.
export function plateTransform(name: Wearable, p: FaceTurn, k: number): string {
  const face = FACE[name];
  if (face) return onFace(face, p, k);
  const head = HEAD[name];
  if (head) return onHead(head, p, k);
  const roll = num(p.roll, 2);
  return roll === "0" ? "" : `rotate(${roll}deg)`;
}

// What a DotView wears: a Blender plate per wearable over the body plates and the face, inside the
// body so it hops, squashes and breathes with it.
export class Wardrobe {
  private worn: Worn[] = [];
  private next: Worn[] = [];
  private key = "";
  private size = 0;
  // The most the eyes may scale in what is on now.
  eyeLimit = Number.POSITIVE_INFINITY;

  constructor(private readonly body: HTMLElement) {}

  // The images of what it has on, or is waiting to put on.
  get images(): readonly HTMLImageElement[] {
    return this.next.map((item) => item.img);
  }

  // A change waits until all that goes on can be drawn, then happens in one frame, which `changed`
  // is told of: what stays on stays where it is, what comes off lifts away and what goes on settles
  // into its place. A later change takes over from one still waiting.
  wear(list: readonly Wearable[], size: number, animate = false, changed?: () => void): void {
    this.size = size;
    const key = list.join(" ");
    if (key === this.key) return;
    this.key = key;
    const known = new Map(this.worn.map((item) => [item.name, item]));
    const next = wornInOrder(list).map((name) => known.get(name) ?? this.putOn(name, animate));
    this.next = next;
    const fresh = next.filter((item) => !known.has(item.name)).map((item) => item.img);
    whenImagesIn(fresh, size, () => {
      if (this.next !== next) return;
      this.change(next, animate);
      changed?.();
    });
  }

  private change(next: Worn[], animate: boolean): void {
    const staying = new Set(next);
    for (const { img } of next) this.body.appendChild(img);
    for (const item of this.worn) {
      if (staying.has(item)) continue;
      const { img } = item;
      if (!animate) {
        img.remove();
        continue;
      }
      img.dataset.leaving = "";
      afterMotion([img], () => img.remove(), false);
    }
    this.worn = next;
    this.eyeLimit = eyeScaleLimit(next.map((item) => item.name));
  }

  private putOn(name: Wearable, animate: boolean): Worn {
    const img = document.createElement("img");
    img.className = "dot-wear";
    img.alt = "";
    img.decoding = "sync";
    img.draggable = false;
    img.dataset.wear = name;
    img.sizes = `${this.size}px`;
    img.srcset = WEAR_PLATES[name];
    if (animate) img.dataset.arriving = "";
    img.style.transformOrigin = plateOrigin(name);
    return { name, img, transform: "", filter: "" };
  }

  setSize(size: number): void {
    this.size = size;
    for (const { img } of new Set([...this.worn, ...this.next])) img.sizes = `${size}px`;
  }

  // k is CSS px per frame unit.
  render(p: DotPose, k: number): void {
    const filter =
      p.plate.dim > 0.001 ? `brightness(${(1 - (1 - DIM_LIGHT) * p.plate.dim).toFixed(3)})` : "";
    for (const item of this.worn) {
      const transform = plateTransform(item.name, p, k);
      if (transform !== item.transform) {
        item.transform = transform;
        item.img.style.transform = transform;
      }
      if (filter !== item.filter) {
        item.filter = filter;
        item.img.style.filter = filter;
      }
    }
  }
}

// A wearable on the face moves as an eye does: the turned sphere carries its anchor, and the
// sphere's slope there foreshortens it.
export function onFace(anchor: Place, p: FaceTurn, k: number): string {
  const f = eyeFrame(anchor, p.gaze.x, p.gaze.y, p.roll);
  const dx = num((f.cx - anchor[0]) * k, 2);
  const dy = num((f.cy - anchor[1]) * k, 2);
  return `matrix(${num(f.a, 4)}, ${num(f.b, 4)}, ${num(f.c, 4)}, ${num(f.d, 4)}, ${dx}, ${dy})`;
}

// A wearable on the head takes its share of the turn at its pivot: the turned sphere carries the
// pivot, and the sphere's slope there tilts and foreshortens the plate, never by more than STRETCH.
// Then it rolls with the face about the body's centre. Its transform-origin is the pivot.
export function onHead({ pivot, follow }: Mount, p: FaceTurn, k: number): string {
  const [px, py] = pivot;
  const [wx, wy] = follow;
  const f = eyeFrame(pivot, p.gaze.x, p.gaze.y, 0);
  const share = (w: number, v: number) => clamp(w * v, -STRETCH, STRETCH);
  const a = 1 + share(wx, f.a - 1);
  const c = share(wx, f.c);
  const b = share(wy, f.b);
  const d = 1 + share(wy, f.d - 1);
  const x = px + wx * (f.cx - px);
  const y = py + wy * (f.cy - py);
  const r = (p.roll * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const m = [cos * a - sin * b, sin * a + cos * b, cos * c - sin * d, sin * c + cos * d];
  const dx = num((cos * x - sin * y - px) * k, 2);
  const dy = num((sin * x + cos * y - py) * k, 2);
  return `matrix(${m.map((v) => num(v, 4)).join(", ")}, ${dx}, ${dy})`;
}
