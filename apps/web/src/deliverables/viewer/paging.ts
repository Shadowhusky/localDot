import { isPresentation } from "@localdot/protocol";

// Pages laid end to end along one axis: where each starts, how long it is, and the whole length.
export interface Run {
  starts: number[];
  lengths: number[];
  total: number;
}

export function run(lengths: readonly number[], gap: number, pad: number): Run {
  const starts: number[] = [];
  let at = pad;
  for (const length of lengths) {
    starts.push(at);
    at += length + gap;
  }
  return { starts, lengths: [...lengths], total: lengths.length ? at - gap + pad : pad * 2 };
}

// The index of the page at `at`, or of the one after the gap `at` falls in.
export function indexAt(r: Run, at: number): number {
  let low = 0;
  let high = r.starts.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((r.starts[middle] ?? 0) + (r.lengths[middle] ?? 0) < at) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low);
}

// The first and last index of the pages within `extra` of the view [from, from + size], never more
// than `most` of them, kept round the page being read.
export function nearby(
  r: Run,
  from: number,
  size: number,
  extra: number,
  most: number,
  reading = indexAt(r, from + size / 2),
): [number, number] {
  if (!r.starts.length) return [0, -1];
  let first = indexAt(r, from - extra);
  let last = indexAt(r, from + size + extra);
  if ((r.starts[last] ?? 0) > from + size + extra) last = Math.max(first, last - 1);
  if (last - first + 1 > most) {
    const half = Math.floor((most - 1) / 2);
    first = Math.max(first, Math.min(reading - half, last - most + 1));
    last = first + most - 1;
  }
  return [first, last];
}

// The page being read, from 1: the one across the upper part of the view, or the last once the view
// can go no further.
export function readingPage(r: Run, scrollTop: number, viewport: number): number {
  const count = r.starts.length;
  // Before the column is measured every page has no length, and the view is at no end yet.
  if (!count || !r.lengths[0]) return 1;
  if (scrollTop + viewport >= r.total - 2) {
    const last = indexAt(r, scrollTop + viewport * 0.4);
    // Short last pages never reach the line; at the end, the last one in view is the one being read.
    return (r.starts[count - 1] ?? 0) < scrollTop + viewport ? count : last + 1;
  }
  return indexAt(r, scrollTop + viewport * 0.4) + 1;
}

export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(1, Math.round(page)), Math.max(1, count));
}

// A page number typed into the counter, or undefined when it is not one.
export function typedPage(text: string, count: number): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return undefined;
  return clampPage(Number(trimmed), count);
}

export type Turn = "next" | "previous" | "first" | "last";
export type Mode = "pages" | "slides";

// What a key does in each mode. Pages scroll up and down by themselves, so only slides take the
// up and down arrows and the space bar.
export function keyTurn(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
  mode: Mode,
): Turn | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey) return undefined;
  const { key } = event;
  if (key === "Home") return "first";
  if (key === "End") return "last";
  if (key === "PageDown") return "next";
  if (key === "PageUp") return "previous";
  if (event.shiftKey) return mode === "slides" && key === " " ? "previous" : undefined;
  if (key === "ArrowRight") return "next";
  if (key === "ArrowLeft") return "previous";
  if (mode === "pages") return undefined;
  if (key === "ArrowDown" || key === " ") return "next";
  if (key === "ArrowUp") return "previous";
  return undefined;
}

export function turned(page: number, turn: Turn, count: number): number {
  if (turn === "first") return 1;
  if (turn === "last") return Math.max(1, count);
  return clampPage(page + (turn === "next" ? 1 : -1), count);
}

// Decks show a slide at a time, as does a PDF whose first page lies on its side; documents,
// workbooks and portrait PDFs show as pages.
export function modeFor(name: string, ratio: number): Mode {
  if (isPresentation(name)) return "slides";
  return /\.pdf$/i.test(name) && ratio >= 1.2 ? "slides" : "pages";
}

// The sizes a page is shown at, as a share of its printed size.
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

// The next size up or down from `scale`, or undefined past the last.
export function zoomStep(scale: number, direction: 1 | -1): number | undefined {
  return direction > 0
    ? ZOOMS.find((z) => z > scale * 1.01)
    : ZOOMS.findLast((z) => z < scale * 0.99);
}

// A page's width at each way of fitting it: across the column, or whole in the view.
export function fittedWidth(
  fit: "width" | "page",
  column: { w: number; h: number },
  ratio: number,
  margin: number,
): number {
  const across = Math.max(120, column.w - margin * 2);
  return fit === "width"
    ? across
    : Math.max(120, Math.min(across, (column.h - margin * 2) * ratio));
}

// The largest a slide can be inside a box while keeping its shape.
export function contain(
  ratio: number,
  box: { w: number; h: number },
  margin: number,
): { w: number; h: number } {
  const w = Math.max(0, box.w - margin * 2);
  const h = Math.max(0, box.h - margin * 2);
  return w / h > ratio ? { w: h * ratio, h } : { w, h: w / ratio };
}
