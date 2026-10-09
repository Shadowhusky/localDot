import type { DotPose } from "../engine/engine.ts";
import type { Lod } from "../engine/states.ts";
import { EYE, EYE_STOPS, GLOSS_STOPS, PEARL_STOPS, SHEEN_STOPS, VOID } from "./dot-colours.ts";
import { type Arc, type EyeGeometry, eyeGeometry } from "./eye-geometry.ts";
import { LOD_DETAIL } from "./lod.ts";
import { type PropLayer, paintProps } from "./prop-paint.ts";

export interface DotPlates {
  neutral: CanvasImageSource;
  xenon: CanvasImageSource;
  dim: CanvasImageSource;
  shadow: CanvasImageSource;
}

type Context = OffscreenCanvasRenderingContext2D;

export interface PaintOptions {
  // The canvas is a square of this many pixels: the dot's whole frame.
  px: number;
  lod: Lod;
  // Without plates the body is drawn, as DotView's SVG skin draws it.
  plates: DotPlates | null;
  xenon: string;
  // The contact shadow, where the level of detail has one; it reads only on the house's dark.
  shadow?: boolean;
}

// Draws one pose of dot the way DotView shows it in the page: the contact shadow, the props behind
// the body, the body plates crossfading to xenon and dim, the face over them and the props in front,
// clipped to the frame as the page clips it.
export function paintDot(ctx: Context, pose: DotPose, o: PaintOptions): void {
  const { px, plates } = o;
  const k = px / 64;
  const detail = LOD_DETAIL[o.lod];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, px, px);
  if (detail.shadow && plates && o.shadow !== false) {
    const s = pose.shadow.s;
    ctx.save();
    ctx.globalAlpha = pose.shadow.o;
    ctx.translate(pose.shadow.x * k, 0);
    around(ctx, 32 * k, 0.92 * px, s * pose.body.sx, s);
    ctx.drawImage(plates.shadow, 0, 0, px, px);
    ctx.restore();
  }
  props(ctx, pose, "back", o.xenon, k);
  ctx.save();
  ctx.translate(pose.body.x * k, pose.body.y * k);
  around(ctx, 32 * k, 56 * k, pose.body.sx, pose.body.sy);
  const rim = pose.plate.rim * (1 - pose.plate.dim);
  const dim = pose.plate.dim;
  if (plates) {
    ctx.drawImage(plates.neutral, 0, 0, px, px);
    layer(ctx, rim, () => ctx.drawImage(plates.xenon, 0, 0, px, px));
    layer(ctx, dim, () => ctx.drawImage(plates.dim, 0, 0, px, px));
  }
  ctx.scale(k, k);
  if (!plates) paintBody(ctx, rim, dim, o.xenon);
  ctx.beginPath();
  ctx.arc(32, 32, 23.75, 0, Math.PI * 2);
  ctx.clip();
  for (const eye of pose.eyes) paintEye(ctx, eyeGeometry(eye, detail, k), detail.gloss);
  ctx.restore();
  props(ctx, pose, "front", o.xenon, k);
}

function props(ctx: Context, pose: DotPose, layer: PropLayer, xenon: string, k: number): void {
  if (!pose.props.length) return;
  ctx.save();
  ctx.scale(k, k);
  paintProps(ctx, pose, layer, xenon);
  ctx.restore();
}

// Scales about a point, as a CSS transform-origin does.
function around(ctx: Context, x: number, y: number, sx: number, sy: number): void {
  ctx.translate(x, y);
  ctx.scale(sx, sy);
  ctx.translate(-x, -y);
}

function layer(ctx: Context, alpha: number, draw: () => void): void {
  if (alpha < 0.0005) return;
  ctx.globalAlpha = alpha;
  draw();
  ctx.globalAlpha = 1;
}

// Fills the current path with a gradient laid out on a box, as SVG's objectBoundingBox units do.
function fillInBox(
  ctx: Context,
  box: { x: number; y: number; w: number; h: number },
  gradient: (ctx: Context) => CanvasGradient,
): void {
  if (box.w < 1e-4 || box.h < 1e-4) return;
  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.scale(box.w, box.h);
  ctx.fillStyle = gradient(ctx);
  ctx.fill();
  ctx.restore();
}

function radial(
  ctx: Context,
  at: { cx: number; cy: number; r: number },
  stops: [number, string][],
): CanvasGradient {
  const gradient = ctx.createRadialGradient(at.cx, at.cy, 0, at.cx, at.cy, at.r);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  return gradient;
}

const DISC = { x: 8, y: 8, w: 48, h: 48 };
const EDGE = { cx: 0.3, cy: 0.62, r: 0.95 };

function paintBody(ctx: Context, rim: number, dim: number, xenon: string): void {
  const disc = () => {
    ctx.beginPath();
    ctx.arc(32, 32, 24, 0, Math.PI * 2);
  };
  disc();
  fillInBox(ctx, DISC, (c) => radial(c, { cx: 0.37, cy: 0.3, r: 0.78 }, PEARL_STOPS));
  fillInBox(ctx, DISC, (c) => radial(c, EDGE, SHEEN_STOPS));
  layer(ctx, rim, () =>
    fillInBox(ctx, DISC, (c) => {
      const gradient = c.createRadialGradient(EDGE.cx, EDGE.cy, 0, EDGE.cx, EDGE.cy, EDGE.r);
      gradient.addColorStop(0, "transparent");
      gradient.addColorStop(0.84, "transparent");
      gradient.addColorStop(0.97, xenon);
      gradient.addColorStop(1, "transparent");
      return gradient;
    }),
  );
  layer(ctx, dim * 0.42, () => {
    disc();
    ctx.fillStyle = VOID;
    ctx.fill();
  });
}

function paintEye(ctx: Context, g: EyeGeometry, gloss: boolean): void {
  if (g.opacity < 0.001) return;
  ctx.save();
  ctx.transform(g.a, g.b, g.c, g.d, g.ex, g.ey);
  ctx.save();
  const { W, top, bottom, slope, dip, arch } = g.lid;
  ctx.beginPath();
  ctx.moveTo(-W, top - slope * W);
  ctx.quadraticCurveTo(0, top + 2 * dip, W, top + slope * W);
  ctx.lineTo(W, bottom);
  ctx.quadraticCurveTo(0, bottom - 2 * arch, -W, bottom);
  ctx.closePath();
  ctx.clip();
  if (g.capsule > 0.0005) {
    ctx.globalAlpha = g.opacity * g.capsule;
    ctx.beginPath();
    ctx.roundRect(-g.hw, -g.hh, 2 * g.hw, 2 * g.hh, g.hw);
    if (gloss) {
      fillInBox(ctx, { x: -g.hw, y: -g.hh, w: 2 * g.hw, h: 2 * g.hh }, (c) => {
        const gradient = c.createLinearGradient(0, 0, 0.35, 1);
        for (const [offset, color] of EYE_STOPS) gradient.addColorStop(offset, color);
        return gradient;
      });
    } else {
      ctx.fillStyle = EYE;
      ctx.fill();
    }
  }
  if (g.gloss) {
    const { cx, cy, rx, ry } = g.gloss;
    ctx.globalAlpha = g.opacity * g.gloss.opacity;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    fillInBox(ctx, { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry }, (c) =>
      radial(c, { cx: 0.5, cy: 0.5, r: 0.5 }, GLOSS_STOPS),
    );
  }
  ctx.restore();
  paintArc(ctx, g.happy, g.opacity);
  paintArc(ctx, g.closed, g.opacity);
  ctx.restore();
}

function paintArc(ctx: Context, a: Arc, opacity: number): void {
  if (a.opacity <= 0.001) return;
  ctx.globalAlpha = opacity * a.opacity;
  ctx.beginPath();
  ctx.moveTo(-a.aw, a.y);
  ctx.quadraticCurveTo(0, a.peak, a.aw, a.y);
  ctx.lineWidth = a.stroke;
  ctx.lineCap = "round";
  ctx.strokeStyle = EYE;
  ctx.stroke();
  ctx.globalAlpha = 1;
}
