import { type Camera, Vector3 } from "three";
import type { Point2 } from "./quad.ts";

// The names of the models dot can use, orbiting it on a tilted ring: the far half passes above dot
// and the near half below, so no name ever covers it.
export class Ring {
  private readonly items: HTMLElement[];
  private readonly drawn: string[] = [];
  private shown = false;

  // `reach` is the ring's radius in dot's radii on a wide screen; names set larger need it wider.
  constructor(
    list: HTMLElement,
    private readonly reach = 2.4,
  ) {
    this.items = [...list.querySelectorAll<HTMLElement>("li")];
  }

  update(
    visible: number,
    turn: number,
    centre: Vector3,
    radius: number,
    camera: Camera,
    toStage: (p: Vector3) => Point2,
    portrait: boolean,
  ): void {
    if (visible <= 0) {
      if (this.shown) for (const item of this.items) item.style.visibility = "hidden";
      this.shown = false;
      // Hidden, nothing drawn stands: the next showing draws every name afresh.
      this.drawn.length = 0;
      return;
    }
    this.shown = true;
    const ring = radius * (portrait ? 2.2 : this.reach);
    const tilt = ((portrait ? 30 : 28) * Math.PI) / 180;
    const items = this.items;
    const toCamera = camera.position.clone().sub(centre).normalize();
    const n = items.length;
    let front = -1;
    let frontness = -2;
    const depths: number[] = [];
    items.forEach((_, i) => {
      const a = (i / n) * Math.PI * 2 + turn;
      const local = new Vector3(Math.cos(a) * ring, 0, Math.sin(a) * ring);
      local.applyAxisAngle(new Vector3(1, 0, 0), tilt);
      const depth = local.clone().normalize().dot(toCamera);
      depths.push(depth);
      if (depth > frontness) {
        frontness = depth;
        front = i;
      }
    });
    const [cx, cy] = toStage(centre);
    const edge = toStage(centre.clone().add(camera.up.clone().multiplyScalar(radius)));
    const body = Math.hypot(edge[0] - cx, edge[1] - cy) * 1.15;
    items.forEach((item, i) => {
      const a = (i / n) * Math.PI * 2 + turn;
      const local = new Vector3(Math.cos(a) * ring, 0, Math.sin(a) * ring);
      local.applyAxisAngle(new Vector3(1, 0, 0), tilt);
      const [x, y] = toStage(centre.clone().add(local));
      const depth = depths[i] ?? 0;
      const near = (depth + 1) / 2;
      const scale = 0.72 + 0.34 * near;
      // A name passing behind dot is hidden by it.
      const behind = depth < 0 && Math.hypot(x - cx, y - cy) < body;
      const opacity = behind ? 0 : visible * (0.22 + 0.78 * near * near);
      const style = `${x.toFixed(1)},${y.toFixed(1)},${scale.toFixed(3)},${opacity.toFixed(3)},${i === front}`;
      if (this.drawn[i] === style) return;
      this.drawn[i] = style;
      item.style.visibility = "visible";
      item.style.opacity = opacity.toFixed(3);
      item.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      item.style.zIndex = String(Math.round(near * 100));
      item.toggleAttribute("data-front", i === front);
    });
  }
}
