import type { Director } from "./director.ts";
import { span } from "./tracks.ts";

// A beat fades in and out over this much of its chapter, or a quarter of its own stretch if less.
const RAMP = 0.06;

// Shows each chapter's words in their beats: a `data-span="from to"` on a beat is the part of its
// chapter it shows for, faded in and out at its ends. A beat may run on into the next chapter.
export class Beats {
  private readonly beats: { el: HTMLElement; chapter: string; from: number; to: number }[] = [];
  private shown = new Map<HTMLElement, string>();
  private readonly seen = new Set<HTMLElement>();
  // Called with a beat's words as it comes into view, so dot can say them.
  onShow: ((text: string) => void) | null = null;

  private readonly still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(
    root: HTMLElement,
    private readonly director: Director,
  ) {
    for (const el of root.querySelectorAll<HTMLElement>("[data-span]")) {
      const chapter = el.closest<HTMLElement>("[data-chapter]")?.dataset.chapter;
      const [from, to] = (el.dataset.span ?? "0 1").split(" ").map(Number);
      if (chapter && from !== undefined && to !== undefined)
        this.beats.push({ el, chapter, from, to });
    }
  }

  update(): void {
    for (const beat of this.beats) {
      const c = this.director.local(beat.chapter as never);
      const ramp = Math.min(RAMP, (beat.to - beat.from) / 4);
      const o = Math.min(
        span(c, beat.from, beat.from + ramp),
        1 - span(c, beat.to - ramp, beat.to),
      );
      if (o > 0.5 && !this.seen.has(beat.el)) {
        this.seen.add(beat.el);
        this.onShow?.(beat.el.querySelector("h2, h3, .role-motto")?.textContent ?? "");
      } else if (o <= 0) this.seen.delete(beat.el);
      const style = o <= 0 ? "hidden" : o.toFixed(3);
      if (this.shown.get(beat.el) === style) continue;
      this.shown.set(beat.el, style);
      beat.el.style.opacity = o <= 0 ? "0" : style;
      beat.el.style.visibility = o <= 0 ? "hidden" : "visible";
      if (!this.still) beat.el.style.transform = `translateY(${((1 - o) * 14).toFixed(1)}px)`;
      beat.el.inert = o < 0.5;
    }
  }
}
