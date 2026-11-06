import { ease, mix } from "../story/tracks.ts";
import { type Point2, quadCss } from "./quad.ts";

// Where the phone shows at a moment of its chapter, in fractions of the stage: its centre, its
// height, its turn in radians, and how visible it is.
export interface PhoneKey {
  at: number;
  x: number;
  y: number;
  h: number;
  yaw: number;
  o: number;
}

export type PhonePose = Omit<PhoneKey, "at">;

// Eased from key to key; held at the ends.
export function phonePose(keys: readonly PhoneKey[], at: number): PhonePose {
  const after = keys.findIndex((key) => key.at > at);
  if (after === 0) return keys[0] as PhoneKey;
  if (after < 0) return keys.at(-1) as PhoneKey;
  const a = keys[after - 1] as PhoneKey;
  const b = keys[after] as PhoneKey;
  const t = ease.inOut((at - a.at) / (b.at - a.at));
  return {
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t),
    h: mix(a.h, b.h, t),
    yaw: mix(a.yaw, b.yaw, t),
    o: mix(a.o, b.o, t),
  };
}

// How much a turn narrows the far edge, as a phone a little way off would look.
const DEPTH = 0.32;

// The corners of the turned phone on the stage, clockwise from its top left.
export function phoneCorners(
  pose: PhonePose,
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

// The phone that shows Chat, placed by the story in 3D as the export clips are.
export class Phone {
  private w = 0;
  private h = 0;
  private shown = "";

  constructor(private readonly el: HTMLElement) {
    this.resize();
  }

  resize(): void {
    this.w = this.el.offsetWidth;
    this.h = this.el.offsetHeight;
  }

  update(pose: PhonePose | null, stage: { w: number; h: number }): void {
    if (!pose || pose.o <= 0.001 || !this.h) {
      if (this.shown === "hidden") return;
      this.shown = "hidden";
      this.el.style.visibility = "hidden";
      return;
    }
    const css = quadCss(this.w, this.h, phoneCorners(pose, stage, this.w / this.h));
    const key = css + pose.o.toFixed(3);
    if (key === this.shown) return;
    this.shown = key;
    this.el.style.visibility = "visible";
    this.el.style.transform = css;
    this.el.style.opacity = pose.o.toFixed(3);
  }
}
