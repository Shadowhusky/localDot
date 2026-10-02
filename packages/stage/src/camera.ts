import type { Point } from "@localdot/protocol";

export interface CameraInput {
  stageW: number;
  stageH: number;
  desktopW: number;
  desktopH: number;
  zoom: number;
  focus?: Point;
}

// canvas = world × scale + (tx, ty); world is desktop device pixels, canvas the backing store.
export interface Camera {
  scale: number;
  tx: number;
  ty: number;
}

export function cameraFor(i: CameraInput): Camera {
  for (const v of [i.stageW, i.stageH, i.desktopW, i.desktopH, i.zoom]) {
    if (!(Number.isFinite(v) && v > 0))
      throw new RangeError("camera inputs must be positive and finite");
  }
  const base = Math.min(i.stageW / i.desktopW, i.stageH / i.desktopH);
  const scale = base * i.zoom;
  const shownW = i.desktopW * scale;
  const shownH = i.desktopH * scale;
  if (i.zoom <= 1) return { scale, tx: (i.stageW - shownW) / 2, ty: (i.stageH - shownH) / 2 };
  const focus = i.focus ?? { x: i.desktopW / 2, y: i.desktopH / 2 };
  const clampT = (want: number, shown: number, stage: number) =>
    shown <= stage ? (stage - shown) / 2 : Math.min(0, Math.max(stage - shown, want));
  return {
    scale,
    tx: clampT(i.stageW / 2 - focus.x * scale, shownW, i.stageW),
    ty: clampT(i.stageH / 2 - focus.y * scale, shownH, i.stageH),
  };
}

export function toCanvas(cam: Camera, p: Point): Point {
  return { x: p.x * cam.scale + cam.tx, y: p.y * cam.scale + cam.ty };
}

export function toWorld(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.tx) / cam.scale, y: (p.y - cam.ty) / cam.scale };
}
