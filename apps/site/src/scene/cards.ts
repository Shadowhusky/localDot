import { Vector3 } from "three";
import { ease, span } from "../story/tracks.ts";
import { type Point2, quadCss } from "./quad.ts";

interface Card {
  el: HTMLElement;
  video: HTMLVideoElement | null;
  w: number;
  h: number;
  // Where it settles in front of dot's screen, its height in world units, and its turn.
  at: Vector3;
  height: number;
  yaw: number;
  // When it comes out, in the beat's progress.
  from: number;
  css: string;
}

// The clips a recording exports to, fanned out in front of dot's screen: each placed in 3D like
// the app's screen itself.
export class Cards {
  private readonly cards: Card[];

  constructor(root: HTMLElement) {
    const spec: Record<
      string,
      { at: [number, number, number]; height: number; yaw: number; from: number }
    > = {
      captions: { at: [-0.25, 0.38, 0.55], height: 0.9, yaw: 0.16, from: 0.0 },
      band: { at: [1.05, 0.05, 0.85], height: 1.05, yaw: -0.24, from: 0.12 },
      corner: { at: [0.15, -0.6, 1.05], height: 0.82, yaw: 0.06, from: 0.24 },
    };
    this.cards = [...root.querySelectorAll<HTMLElement>("[data-card]")].map((el) => {
      const s = spec[el.dataset.card ?? "captions"] ?? spec.captions;
      return {
        el,
        video: el.querySelector("video"),
        w: el.offsetWidth || 640,
        h: el.offsetHeight || 400,
        at: new Vector3(...(s?.at ?? [0, 0, 0])),
        height: s?.height ?? 0.7,
        yaw: s?.yaw ?? 0,
        from: s?.from ?? 0,
        css: "",
      };
    });
  }

  resize(): void {
    for (const card of this.cards) {
      card.w = card.el.offsetWidth || card.w;
      card.h = card.el.offsetHeight || card.h;
    }
  }

  // `beat` runs 0 to 1 over the export beat; `toStage` projects world points to stage pixels. On a
  // portrait screen the looks spread half as wide, so none runs off its side.
  update(beat: number, toStage: (p: Vector3) => Point2, portrait = false): void {
    const spread = portrait ? 0.5 : 1;
    for (const card of this.cards) {
      const t = ease.out(span(beat, card.from, card.from + 0.34));
      const leave = span(beat, 0.92, 1);
      const shown = t > 0 && leave < 1;
      if (card.video) {
        if (shown && card.video.paused) card.video.play().catch(() => {});
        else if (!shown && !card.video.paused) card.video.pause();
      }
      if (!shown) {
        if (card.css !== "hidden") {
          card.css = "hidden";
          card.el.style.visibility = "hidden";
        }
        continue;
      }
      const scale = 0.55 + 0.45 * t;
      const h = card.height * scale;
      const w = h * (card.w / card.h);
      const centre = new Vector3(card.at.x * spread * t, card.at.y * t, card.at.z * t);
      const right = new Vector3(Math.cos(card.yaw * t), 0, -Math.sin(card.yaw * t)).multiplyScalar(
        w / 2,
      );
      const up = new Vector3(0, h / 2, 0);
      const corners = [
        centre.clone().sub(right).add(up),
        centre.clone().add(right).add(up),
        centre.clone().add(right).sub(up),
        centre.clone().sub(right).sub(up),
      ].map(toStage);
      const css = quadCss(card.w, card.h, corners);
      const opacity = (Math.min(1, t * 1.6) * (1 - leave)).toFixed(3);
      const key = css + opacity;
      if (key === card.css) continue;
      card.css = key;
      card.el.style.visibility = "visible";
      card.el.style.transform = css;
      card.el.style.opacity = opacity;
    }
  }
}
