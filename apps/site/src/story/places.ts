import { ROLE_ORDER, ROLES_FROM, ROLES_TO } from "./content.ts";
import type { ChapterName, ChapterRange } from "./director.ts";

// A place in the story the address can name: where it begins, in screens from the story's top, and
// where it shows whole, the middle of its stretch.
export interface Place {
  name: string;
  chapter: ChapterName;
  from: number;
  at: number;
}

// Each beat with a `data-place`, and each dot's own stretch of the Dots chapter, in story order.
export function places(root: ParentNode, chapters: readonly ChapterRange[]): Place[] {
  const found: Place[] = [];
  const add = (name: string, chapter: ChapterRange, from: number, to: number) => {
    const length = chapter.to - chapter.from;
    found.push({
      name,
      chapter: chapter.name,
      from: chapter.from + from * length,
      at: Math.min(chapter.to, chapter.from + ((from + to) / 2) * length),
    });
  };
  for (const el of root.querySelectorAll<HTMLElement>("[data-place]")) {
    const name = el.closest<HTMLElement>("[data-chapter]")?.dataset.chapter;
    const chapter = chapters.find((c) => c.name === name);
    const [from = 0, to = 1] = (el.dataset.span ?? "0 1").split(" ").map(Number);
    if (chapter && el.dataset.place) add(el.dataset.place, chapter, from, to);
  }
  const dots = chapters.find((c) => c.name === "dots");
  const step = (ROLES_TO - ROLES_FROM) / ROLE_ORDER.length;
  if (dots)
    for (const [i, id] of ROLE_ORDER.entries())
      add(id, dots, ROLES_FROM + i * step, ROLES_FROM + (i + 1) * step);
  return found.sort((a, b) => a.from - b.from);
}

// The place the story is at: the last one begun, or none before the first.
export function placeAt(list: readonly Place[], progress: number): Place | null {
  let current: Place | null = null;
  for (const place of list) if (place.from <= progress) current = place;
  return current;
}
