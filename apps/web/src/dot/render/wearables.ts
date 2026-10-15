import type { Wearable } from "@localdot/protocol";
import type { DotPose } from "../engine/engine.ts";
import { eyeFrame } from "../engine/sphere.ts";
import { WEAR_PLATES } from "../plates.ts";

// Where on the face a wearable sits, in frame units from the body's centre. It turns with the face
// as the eyes do. Everything else stays with the body, which a turn of the sphere leaves where it
// was, and follows only the face's roll about the centre, so it never leaves the ball's outline.
const FACE: Partial<Record<Wearable, readonly [number, number]>> = {
  "round-glasses": [0, -4.5],
  sunglasses: [0, -4.5],
  mustache: [0, 6],
};

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
  face: readonly [number, number] | undefined;
  transform: string;
  filter: string;
}

const num = (v: number, digits: number) => (Math.abs(v) < 10 ** -digits ? "0" : v.toFixed(digits));

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
      if (face) {
        const [x, y] = face.map((v) => `${((32 + v) / 64) * 100}%`);
        img.style.transformOrigin = `${x} ${y}`;
      }
      this.body.appendChild(img);
      return { img, face, transform: "", filter: "" };
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
export function onFace(anchor: readonly [number, number], p: DotPose, k: number): string {
  const f = eyeFrame(anchor, p.gaze.x, p.gaze.y, p.roll);
  const dx = num((f.cx - anchor[0]) * k, 2);
  const dy = num((f.cy - anchor[1]) * k, 2);
  return `matrix(${num(f.a, 4)}, ${num(f.b, 4)}, ${num(f.c, 4)}, ${num(f.d, 4)}, ${dx}, ${dy})`;
}
