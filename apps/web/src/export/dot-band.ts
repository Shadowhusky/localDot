import type { DotPlacement, ExportRequest, ExportSize } from "@localdot/protocol";
import { LINE_HOLD_MS, LINE_IN_MS, LINE_OUT_MS } from "../shell/narration.ts";

// dot in a video is laid out as the app lays it out on a laptop (design-v2 §8.1, §10.17): a stage
// 1024 wide with a 112 band under it, dot's 96 frame at its corner and its line beside it, all
// scaled with the video's width. On the picture it sits in a corner with its line in a bubble.
export const DOT_LAYOUT_W = 1024;
const BAND_H = 112;
const SPILL_H = 170;

export function bandHeight(width: number): number {
  return 2 * Math.round((width * BAND_H) / DOT_LAYOUT_W / 2);
}

export function withBand(picture: ExportSize): ExportSize {
  return { w: picture.w, h: picture.h + bandHeight(picture.w) };
}

// The picture's own height in a video of this size; the rest is dot's band.
export function pictureHeight(request: Pick<ExportRequest, "size" | "dot">): number {
  return request.dot === "under" ? request.size.h - bandHeight(request.size.w) : request.size.h;
}

export interface DotLayout {
  scale: number;
  pictureH: number;
  // dot's whole frame (the ball is three quarters of it), in video pixels.
  frame: { x: number; y: number; size: number };
  // Where the line starts, the height its lines centre on and how wide they may run.
  line: { x: number; centreY: number; maxW: number; maxLines: number };
  type: { size: number; lineHeight: number; tracking: number };
  // On the picture, the line sits on glass with this padding and corner.
  bubble: { padX: number; padY: number; radius: number } | null;
  // Under the picture: the band, and the light the stage throws on it.
  band: { y: number; h: number; spillH: number } | null;
}

export function dotLayout(size: ExportSize, placement: DotPlacement): DotLayout {
  const s = size.w / DOT_LAYOUT_W;
  if (placement === "under") {
    const pictureH = size.h - bandHeight(size.w);
    return {
      scale: s,
      pictureH,
      frame: { x: 8 * s, y: pictureH, size: 96 * s },
      line: { x: 112 * s, centreY: pictureH + 48 * s, maxW: 600 * s, maxLines: 2 },
      type: { size: 16 * s, lineHeight: 22 * s, tracking: -0.019 * 16 * s },
      bubble: null,
      band: { y: pictureH, h: size.h - pictureH, spillH: SPILL_H * s },
    };
  }
  return {
    scale: s,
    pictureH: size.h,
    frame: { x: 10 * s, y: size.h - 90 * s, size: 80 * s },
    line: { x: 104 * s, centreY: size.h - 50 * s, maxW: 440 * s, maxLines: 2 },
    type: { size: 15 * s, lineHeight: 21 * s, tracking: -0.015 * 15 * s },
    bubble: { padX: 14 * s, padY: 9 * s, radius: 18 * s },
    band: null,
  };
}

const easeOut = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

// The line on show at each moment of the video, timed as the band times it in the app: a new line
// waits until the last has shown for its hold, the last fades out, then the new one fades in.
export class LineTrack {
  #text: string;
  #since: number;
  #next: { line: string; at: number } | null = null;

  constructor(line: string, t: number) {
    this.#text = line;
    this.#since = t;
  }

  at(line: string, t: number): { text: string; alpha: number } {
    if (line === this.#text) this.#next = null;
    else if (this.#next?.line !== line) this.#next = { line, at: this.#next?.at ?? t };
    if (this.#next) {
      const leave = Math.max(this.#next.at, this.#since + LINE_HOLD_MS);
      const swap = leave + (this.#text ? LINE_OUT_MS : 0);
      if (t >= swap) {
        this.#text = this.#next.line;
        this.#since = swap;
        this.#next = null;
      } else if (t >= leave) {
        return { text: this.#text, alpha: 1 - easeOut((t - leave) / LINE_OUT_MS) };
      }
    }
    return { text: this.#text, alpha: this.#text ? easeOut((t - this.#since) / LINE_IN_MS) : 0 };
  }
}

// The text cut at a word, with an ellipsis, so it wraps to at most `maxLines` lines.
export function clampLines(text: string, maxLines: number, lines: (text: string) => number) {
  if (lines(text) <= maxLines) return text;
  const fits = (cut: string) => lines(cut) <= maxLines;
  const words = text.split(" ");
  const byWords = (n: number) =>
    `${words
      .slice(0, n)
      .join(" ")
      .replace(/[\s,;:.–—-]+$/, "")}…`;
  const most = longest(words.length - 1, (n) => fits(byWords(n)));
  if (most > 0) return byWords(most);
  // One word longer than the lines: cut inside it.
  return `${text.slice(
    0,
    longest(text.length - 1, (n) => fits(`${text.slice(0, n)}…`)),
  )}…`;
}

// The largest n in 0..upper for which ok(n) holds, given that it holds for every smaller n.
function longest(upper: number, ok: (n: number) => boolean): number {
  let lower = 0;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (ok(middle)) lower = middle;
    else upper = middle - 1;
  }
  return lower;
}

// The same recording moves its dot the same way wherever the video is made.
export function dotSeed(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index++)
    hash = Math.imul(hash ^ sessionId.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}
