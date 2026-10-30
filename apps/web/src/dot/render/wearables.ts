import type { Wearable } from "@localdot/protocol";
import type { DotPose } from "../engine/engine.ts";
import { clamp } from "../engine/math.ts";
import { eyeFrame } from "../engine/sphere.ts";
import { WEAR_PLATES } from "../plates.ts";

type Place = readonly [number, number];

// Where on the face a wearable sits, in frame units from the body's centre. It turns with the face
// as the eyes do.
const FACE: Partial<Record<Wearable, Place>> = {
  "round-glasses": [0, -4.5],
  sunglasses: [0, -4.5],
  mustache: [0, 6],
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
  cap: { pivot: [0, -15], follow: [0.5, 1], crown: 5.5 },
  beret: { pivot: [-2, -18], follow: [0.5, 1], crown: 4.25 },
  mortarboard: { pivot: [0, -14], follow: [0.5, 1], crown: 3 },
  // The cups sit on the outline, where a turn only carries them round the back.
  headphones: { pivot: [0, -21], follow: [0.2, 0.4], crown: 2 },
  bow: { pivot: [-11, -17], follow: [0.6, 1], crown: 0 },
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
  cap: 2,
  beret: 2,
  mortarboard: 2,
  headphones: 2,
  bow: 3,
  "star-pin": 3,
  "round-glasses": 4,
  sunglasses: 4,
  mustache: 4,
};

// The wearables are rendered under the neutral light; the dim plate keeps this much of it.
const DIM_LIGHT = 0.3;

interface Worn {
  img: HTMLImageElement;
  face: Place | undefined;
  head: Mount | undefined;
  transform: string;
  filter: string;
}

const num = (v: number, digits: number) => (Math.abs(v) < 10 ** -digits ? "0" : v.toFixed(digits));
const origin = ([x, y]: Place) => `${((32 + x) / 64) * 100}% ${((32 + y) / 64) * 100}%`;

// What a DotView wears: a Blender plate per wearable over the body plates and the face, inside the
// body so it hops, squashes and breathes with it.
export class Wardrobe {
  private worn: Worn[] = [];
  private key = "";

  constructor(private readonly body: HTMLElement) {}

  wear(list: readonly Wearable[], size: number): void {
    const key = list.join(" ");
    if (key === this.key) return;
    this.key = key;
    for (const item of this.worn) item.img.remove();
    const ordered = [...list].sort((a, b) => LAYER[a] - LAYER[b]);
    this.worn = ordered.map((name) => {
      const img = document.createElement("img");
      img.className = "dot-wear";
      img.alt = "";
      img.decoding = "async";
      img.draggable = false;
      img.dataset.wear = name;
      img.sizes = `${size}px`;
      img.srcset = WEAR_PLATES[name];
      const face = FACE[name];
      const head = HEAD[name];
      const pivot = face ?? head?.pivot;
      if (pivot) img.style.transformOrigin = origin(pivot);
      this.body.appendChild(img);
      return { img, face, head, transform: "", filter: "" };
    });
  }

  setSize(size: number): void {
    for (const { img } of this.worn) img.sizes = `${size}px`;
  }

  // k is CSS px per frame unit.
  render(p: DotPose, k: number): void {
    const filter =
      p.plate.dim > 0.001 ? `brightness(${(1 - (1 - DIM_LIGHT) * p.plate.dim).toFixed(3)})` : "";
    const roll = num(p.roll, 2);
    for (const item of this.worn) {
      const transform = item.face
        ? onFace(item.face, p, k)
        : item.head
          ? onHead(item.head, p, k)
          : roll === "0"
            ? ""
            : `rotate(${roll}deg)`;
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
export function onFace(anchor: Place, p: DotPose, k: number): string {
  const f = eyeFrame(anchor, p.gaze.x, p.gaze.y, p.roll);
  const dx = num((f.cx - anchor[0]) * k, 2);
  const dy = num((f.cy - anchor[1]) * k, 2);
  return `matrix(${num(f.a, 4)}, ${num(f.b, 4)}, ${num(f.c, 4)}, ${num(f.d, 4)}, ${dx}, ${dy})`;
}

// A wearable on the head takes its share of the turn at its pivot: the turned sphere carries the
// pivot, and the sphere's slope there tilts and foreshortens the plate, never by more than STRETCH.
// Then it rolls with the face about the body's centre. Its transform-origin is the pivot.
export function onHead({ pivot, follow }: Mount, p: DotPose, k: number): string {
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
