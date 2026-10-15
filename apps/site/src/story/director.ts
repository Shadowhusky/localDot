import { follow, span } from "./tracks.ts";

export type ChapterName =
  | "app"
  | "out"
  | "watch"
  | "models"
  | "replay"
  | "dots"
  | "yours"
  | "install";

// A chapter's place in the story, in screens of scrolling from the story's top.
export interface ChapterRange {
  name: ChapterName;
  from: number;
  to: number;
}

export function layout(lengths: readonly (readonly [ChapterName, number])[]): ChapterRange[] {
  let at = 0;
  return lengths.map(([name, screens]) => {
    const range = { name, from: at, to: at + screens };
    at += screens;
    return range;
  });
}

// Scroll position as story progress. The scene reads the smoothed value, so a wheel's coarse steps
// glide; with reduced motion it reads the scroll itself.
export class Director {
  readonly screens: number;
  #top = 0;
  #viewport = 1;
  #raw = 0;
  #at = 0;
  readonly #halfLife: number;
  readonly #reduced: boolean;
  readonly #ranges: ReadonlyMap<ChapterName, ChapterRange>;

  constructor(
    chapters: readonly ChapterRange[],
    options: { halfLifeMs?: number; reduced?: boolean } = {},
  ) {
    this.screens = chapters.at(-1)?.to ?? 0;
    this.#ranges = new Map(chapters.map((c) => [c.name, c]));
    this.#halfLife = options.halfLifeMs ?? 90;
    this.#reduced = options.reduced ?? false;
  }

  // The story's top in document pixels and the viewport's height.
  measure(top: number, viewport: number): void {
    this.#top = top;
    this.#viewport = Math.max(1, viewport);
  }

  scroll(y: number): void {
    this.#raw = Math.min(this.screens, Math.max(0, (y - this.#top) / this.#viewport));
    if (this.#reduced) this.#at = this.#raw;
  }

  // The scroll that puts the story at `progress`.
  scrollFor(progress: number): number {
    return this.#top + progress * this.#viewport;
  }

  // Lands on the scroll at once, as after a jump to a far chapter.
  snap(): void {
    this.#at = this.#raw;
  }

  update(dtMs: number): void {
    this.#at = this.#reduced ? this.#raw : follow(this.#at, this.#raw, dtMs, this.#halfLife);
    if (Math.abs(this.#at - this.#raw) < 1e-4) this.#at = this.#raw;
  }

  get raw(): number {
    return this.#raw;
  }

  get at(): number {
    return this.#at;
  }

  settled(): boolean {
    return this.#at === this.#raw;
  }

  chapter(name: ChapterName): number {
    const range = this.#ranges.get(name);
    return range ? span(this.#at, range.from, range.to) : 0;
  }

  // Progress through a chapter, below 0 before it and above 1 after it.
  local(name: ChapterName): number {
    const range = this.#ranges.get(name);
    return range ? (this.#at - range.from) / (range.to - range.from) : 0;
  }
}
