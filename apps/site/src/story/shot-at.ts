import { Vector3 } from "three";
import type { ChapterRange } from "./director.ts";
import type { Shot } from "./shots.ts";
import { ease, mix } from "./tracks.ts";

export interface ShotNow {
  camera: Vector3;
  target: Vector3;
  dot: { x: number; y: number; r: number; depth: number };
  screen: number;
}

// The shot at a place in the story, in screens, eased between the shots on either side.
export function shotAt(
  shots: readonly Shot[],
  chapters: readonly ChapterRange[],
  at: number,
): ShotNow {
  const place = (shot: Shot) => {
    const range = chapters.find((c) => c.name === shot.chapter);
    return range ? range.from + shot.at * (range.to - range.from) : 0;
  };
  let i = 0;
  while (i < shots.length - 1 && place(shots[i + 1] as Shot) <= at) i++;
  const a = shots[i] as Shot;
  const b = shots[Math.min(i + 1, shots.length - 1)] as Shot;
  const from = place(a);
  const to = place(b);
  const t = to > from ? ease.inOut(Math.min(1, Math.max(0, (at - from) / (to - from)))) : 0;
  const v = (p: readonly [number, number, number], q: readonly [number, number, number]) =>
    new Vector3(mix(p[0], q[0], t), mix(p[1], q[1], t), mix(p[2], q[2], t));
  return {
    camera: v(a.camera, b.camera),
    target: v(a.target, b.target),
    dot: {
      x: mix(a.dot.x, b.dot.x, t),
      y: mix(a.dot.y, b.dot.y, t),
      r: mix(a.dot.r, b.dot.r, t),
      depth: mix(a.dot.depth, b.dot.depth, t),
    },
    screen: mix(a.screen, b.screen, t),
  };
}
