import { ease, mix } from "../story/tracks.ts";
import { type Point2, quadCss } from "./quad.ts";

// Where a picture of the app shows at a moment of its chapter, in fractions of the stage: its centre,
// its height, its turn in radians, and how visible it is.
export interface PanelKey {
  at: number;
  x: number;
  y: number;
  h: number;
  yaw: number;
  o: number;
}

export type PanelPose = Omit<PanelKey, "at">;

// Eased from key to key; held at the ends.
export function panelPose(keys: readonly PanelKey[], at: number): PanelPose {
  const after = keys.findIndex((key) => key.at > at);
  if (after === 0) return keys[0] as PanelKey;
  if (after < 0) return keys.at(-1) as PanelKey;
  const a = keys[after - 1] as PanelKey;
  const b = keys[after] as PanelKey;
  const t = ease.inOut((at - a.at) / (b.at - a.at));
  return {
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t),
    h: mix(a.h, b.h, t),
    yaw: mix(a.yaw, b.yaw, t),
    o: mix(a.o, b.o, t),
  };
}

// How much a turn narrows the far edge, as a picture a little way off would look.
const DEPTH = 0.32;

// The corners of the turned picture on the stage, clockwise from its top left.
export function panelCorners(
  pose: PanelPose,
  stage: { w: number; h: number },
  aspect: number,
): [Point2, Point2, Point2, Point2] {
  const height = pose.h * stage.h;
  const across = (height * aspect * Math.cos(pose.yaw)) / 2;
  const x = pose.x * stage.w;
  const y = pose.y * stage.h;
  const left = (height / 2) * (1 + Math.sin(pose.yaw) * DEPTH);
  const right = (height / 2) * (1 - Math.sin(pose.yaw) * DEPTH);
  return [
    [x - across, y - left],
    [x + across, y - right],
    [x + across, y + right],
    [x - across, y + left],
  ];
}

// A picture of the app, laid out once at its own size and placed by the story in 3D as the export clips
// are: the phone that shows Chat, and the app with several tasks at once.
export class Panel {
  private w = 0;
  private h = 0;
  private shown = "";

  constructor(readonly el: HTMLElement) {
    this.resize();
  }

  resize(): void {
    this.w = this.el.offsetWidth;
    this.h = this.el.offsetHeight;
  }

  get aspect(): number {
    return this.h ? this.w / this.h : 1;
  }

  update(pose: PanelPose | null, stage: { w: number; h: number }): void {
    if (!pose || pose.o <= 0.001 || !this.h) {
      if (this.shown === "hidden") return;
      this.shown = "hidden";
      this.el.style.visibility = "hidden";
      return;
    }
    const css = quadCss(this.w, this.h, panelCorners(pose, stage, this.aspect));
    const key = css + pose.o.toFixed(3);
    if (key === this.shown) return;
    this.shown = key;
    this.el.style.visibility = "visible";
    this.el.style.transform = css;
    this.el.style.opacity = pose.o.toFixed(3);
  }
}
