import type { EyePose } from "../engine/engine.ts";
import { clamp, smoothstep } from "../engine/math.ts";
import type { LodDetail } from "./lod.ts";

export interface Arc {
  // Half the arc's width, the height of its ends and of its control point, and its stroke.
  aw: number;
  y: number;
  peak: number;
  stroke: number;
  opacity: number;
}

// One eye in its own units, as both renderers draw it: placed by matrix (a b c d ex ey) in the
// 64-unit frame, a capsule (x -hw..hw, y -hh..hh) clipped by the lids, a gloss, and the happy and
// sleeping arcs that morph in as the lids close.
export interface EyeGeometry {
  a: number;
  b: number;
  c: number;
  d: number;
  ex: number;
  ey: number;
  opacity: number;
  hw: number;
  hh: number;
  // The lid clip: upper lid from (-W, top - slope·W) through Q(0, top + 2·dip) to (W, top + slope·W),
  // then the lower lid from (W, bottom) through Q(0, bottom - 2·arch) to (-W, bottom).
  lid: { W: number; top: number; bottom: number; slope: number; dip: number; arch: number };
  capsule: number;
  gloss: { cx: number; cy: number; rx: number; ry: number; opacity: number } | null;
  happy: Arc;
  closed: Arc;
}

export function eyeGeometry(s: EyePose, d: LodDetail, devPerUnit: number): EyeGeometry {
  const f = s.frame;
  let ex = 32 + f.cx;
  let ey = 32 + f.cy;
  if (d.snap) {
    ex = Math.round(ex * devPerUnit * 2) / (devPerUnit * 2);
    ey = Math.round(ey * devPerUnit * 2) / (devPerUnit * 2);
  }
  const scale = s.scale * d.eyeScale;
  const w = 5.4 * scale;
  const h = 10 * scale * s.sy;
  const hw = w / 2;
  const hh = h / 2;
  const { happy, closed } = s;
  let up = Math.max(s.up, closed * 0.93);
  let lo = Math.max(s.lo, happy * 0.86);
  const dip = closed * 0.22 * h + Math.min(up, 0.6) * 0.09 * h;
  const arch = happy * 0.3 * h + s.loArch * h;
  // A blink never closes below one device pixel, so it still reads at the badge size.
  const minOpen = 1 / devPerUnit;
  if (Math.max(1 - up - lo, 0) * h < minOpen && happy < 0.5 && closed < 0.5) {
    const keep = clamp(1 - minOpen / h, 0, 1);
    const total = up + lo || 1;
    up = keep * (up / total);
    lo = keep * (lo / total);
  }
  const capsule = (1 - smoothstep(0.7, 1, happy)) * (1 - smoothstep(0.78, 1, closed));
  return {
    a: f.a,
    b: f.b,
    c: f.c,
    d: f.d,
    ex,
    ey,
    opacity: s.opacity,
    hw,
    hh,
    lid: {
      W: hw + 2.5,
      top: -hh + up * h,
      bottom: hh - lo * h,
      slope: Math.tan((s.tilt * d.tiltGain * Math.PI) / 180),
      dip,
      arch,
    },
    capsule,
    // A soft reflection of the key softbox (upper left), not a cartoon sparkle.
    gloss:
      d.gloss && capsule > 0.01
        ? {
            cx: -0.85 * scale,
            cy: -hh + 2.7 * scale,
            rx: 1.05 * scale,
            ry: 2.1 * scale,
            opacity: 0.5 * capsule,
          }
        : null,
    happy: {
      aw: hw + 0.75 * scale,
      y: 1.1 * scale,
      peak: -4.1 * scale,
      stroke: 2.1 * scale,
      opacity: smoothstep(0.45, 0.92, happy),
    },
    closed: {
      aw: hw + 0.45 * scale,
      y: 1.9 * scale,
      peak: 4.9 * scale,
      stroke: 1.9 * scale,
      opacity: smoothstep(0.5, 0.95, closed),
    },
  };
}
