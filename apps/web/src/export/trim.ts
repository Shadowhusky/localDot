import type { ScreenName } from "@localdot/protocol";
import { chapters, observeAt, type SessionModel } from "@localdot/stage";
import { timeLabel } from "../replay/replay-view.ts";

export interface TrimRange {
  fromMs: number;
  toMs: number;
}
export type TrimEdge = "from" | "to";
export type TrimShortcut = "whole" | "chapter" | "selection";

// The shortest part a trim keeps: half a second, or all of a shorter recording.
export const MIN_TRIM_MS = 500;
// How near, in pixels, a dragged handle comes to a step's edge before it stops there.
export const SNAP_PX = { fine: 8, coarse: 14 } as const;
// A dragged or typed handle moves in tenths of a second, the steps the times are shown in.
const STEP_MS = 100;
// Thumbnails keep the picture's own proportion.
const TILE_RATIO = 1.6;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function shortestTrim(whole: TrimRange): number {
  return Math.min(MIN_TRIM_MS, Math.max(0, whole.toMs - whole.fromMs));
}

// A range inside the recording and at least the shortest trim long, in whole milliseconds.
export function fitTrim(range: TrimRange, whole: TrimRange): TrimRange {
  const shortest = shortestTrim(whole);
  const fromMs = Math.round(clamp(range.fromMs, whole.fromMs, whole.toMs - shortest));
  const toMs = Math.round(clamp(range.toMs, fromMs + shortest, whole.toMs));
  return { fromMs, toMs };
}

// Where one handle may go: inside the recording, and no nearer the other than the shortest trim.
export function edgeLimits(
  range: TrimRange,
  whole: TrimRange,
  edge: TrimEdge,
): { min: number; max: number } {
  const shortest = shortestTrim(whole);
  return edge === "from"
    ? { min: whole.fromMs, max: Math.max(whole.fromMs, range.toMs - shortest) }
    : { min: Math.min(whole.toMs, range.fromMs + shortest), max: whole.toMs };
}

export function moveEdge(
  range: TrimRange,
  whole: TrimRange,
  edge: TrimEdge,
  timeMs: number,
): TrimRange {
  const { min, max } = edgeLimits(range, whole, edge);
  const at = Math.round(clamp(timeMs, min, max));
  return edge === "from" ? { fromMs: at, toMs: range.toMs } : { fromMs: range.fromMs, toMs: at };
}

// dot's steps, each as the part of the recording it took.
export function stepSpans(model: SessionModel, whole: TrimRange): TrimRange[] {
  return chapters(model, whole.toMs)
    .map((chapter) => ({
      fromMs: Math.max(whole.fromMs, chapter.startT),
      toMs: Math.min(whole.toMs, chapter.endT),
    }))
    .filter((span) => span.toMs > span.fromMs);
}

// Each moment inside the recording where a step starts or ends, in order, once.
export function stepEdges(spans: readonly TrimRange[], whole: TrimRange): number[] {
  const edges = new Set<number>();
  for (const span of spans)
    for (const time of [span.fromMs, span.toMs])
      if (time > whole.fromMs && time < whole.toMs) edges.add(time);
  return [...edges].sort((a, b) => a - b);
}

// The step edge nearest a time, when one is within reach.
export function snapTo(timeMs: number, edges: readonly number[], reachMs: number): number | null {
  let nearest: number | null = null;
  let distance = reachMs;
  for (const edge of edges) {
    const gap = Math.abs(edge - timeMs);
    if (gap <= distance) {
      nearest = edge;
      distance = gap;
    }
  }
  return nearest;
}

// The moment under a point on the strip, whose film spans `left` to `left + width`.
export function timeAtX(
  x: number,
  track: { left: number; width: number },
  whole: TrimRange,
): number {
  const share = track.width > 0 ? clamp((x - track.left) / track.width, 0, 1) : 0;
  return whole.fromMs + share * (whole.toMs - whole.fromMs);
}

// A handle dragged to a moment: on a step's edge when snapping reaches one, else on the tenth of a
// second, and always where it may go. `snapped` names the edge it stopped on.
export function dragEdge(
  range: TrimRange,
  whole: TrimRange,
  edge: TrimEdge,
  timeMs: number,
  snap: { edges: readonly number[]; reachMs: number } | null,
): { range: TrimRange; snapped: number | null } {
  const snapped = snap ? snapTo(timeMs, snap.edges, snap.reachMs) : null;
  const next = moveEdge(range, whole, edge, snapped ?? Math.round(timeMs / STEP_MS) * STEP_MS);
  const at = edge === "from" ? next.fromMs : next.toMs;
  return { range: next, snapped: snapped !== null && Math.round(snapped) === at ? snapped : null };
}

// A key pressed on a handle: arrows move it a tenth of a second (a second with Shift, to the next
// step's edge with Option), Page Up and Page Down ten seconds, Home and End as far as it may go.
export function nudgeEdge(
  range: TrimRange,
  whole: TrimRange,
  edge: TrimEdge,
  key: { key: string; shiftKey?: boolean; altKey?: boolean },
  edges: readonly number[],
): TrimRange | null {
  const at = edge === "from" ? range.fromMs : range.toMs;
  const limits = edgeLimits(range, whole, edge);
  const direction =
    key.key === "ArrowRight" || key.key === "ArrowUp"
      ? 1
      : key.key === "ArrowLeft" || key.key === "ArrowDown"
        ? -1
        : 0;
  let target: number | undefined;
  if (direction && key.altKey)
    target =
      direction > 0
        ? (edges.find((time) => time > at + 0.5) ?? whole.toMs)
        : (edges.findLast((time) => time < at - 0.5) ?? whole.fromMs);
  else if (direction) target = at + direction * (key.shiftKey ? 1000 : 100);
  else if (key.key === "PageUp") target = at + 10_000;
  else if (key.key === "PageDown") target = at - 10_000;
  else if (key.key === "Home") target = limits.min;
  else if (key.key === "End") target = limits.max;
  return target === undefined ? null : moveEdge(range, whole, edge, target);
}

// m:ss.d, in the tenths of a second a handle moves in.
export function trimTimeLabel(ms: number): string {
  const tenths = Number.isFinite(ms) ? Math.max(0, Math.floor(Math.round(ms) / 100)) : 0;
  return `${timeLabel(Math.floor(tenths / 10) * 1000)}.${tenths % 10}`;
}

// A typed moment: "1:05", "1:05.3", "65", "65.3 s" or "1:02:03", in milliseconds on the nearest
// tenth of a second. Null when it isn't one.
export function parseTrimTime(text: string): number | null {
  const match = /^\s*((?:\d+:){0,2})(\d+(?:[.,]\d*)?)\s*s?\s*$/i.exec(text);
  if (!match) return null;
  const head = (match[1] ?? "").split(":").filter(Boolean).map(Number);
  const seconds = Number((match[2] ?? "").replace(",", "."));
  if (head.length > 0 && seconds >= 60) return null;
  if (head.length === 2 && (head[1] ?? 0) >= 60) return null;
  const total = head.reduce((sum, part) => sum * 60 + part, 0) * 60 + seconds;
  return Number.isFinite(total) ? Math.round((total * 1000) / STEP_MS) * STEP_MS : null;
}

// Which of Whole, This step and Selection the handles hold, if any.
export function shortcutOf(
  range: TrimRange,
  shortcuts: Record<TrimShortcut, TrimRange | null>,
  whole: TrimRange,
): TrimShortcut | null {
  for (const name of ["whole", "chapter", "selection"] as const) {
    const shortcut = shortcuts[name];
    if (!shortcut) continue;
    const fitted = fitTrim(shortcut, whole);
    if (fitted.fromMs === range.fromMs && fitted.toMs === range.toMs) return name;
  }
  return null;
}

export function tileCount(widthPx: number, heightPx: number): number {
  return widthPx > 0 && heightPx > 0
    ? Math.max(1, Math.ceil(widthPx / (heightPx * TILE_RATIO)))
    : 0;
}

// The key frame each tile shows: the picture on the screen at the tile's middle, or the first one
// recorded after it.
export function filmstrip(
  model: SessionModel,
  whole: TrimRange,
  screen: ScreenName,
  count: number,
): (string | null)[] {
  const span = whole.toMs - whole.fromMs;
  const first = model.observes.find(
    (entry) => entry.t >= whole.fromMs && (entry.screen ?? "desktop") === screen,
  );
  return Array.from(
    { length: count },
    (_, index) =>
      (observeAt(model, whole.fromMs + ((index + 0.5) / count) * span, screen) ?? first)?.frameId ??
      null,
  );
}

// The picture at a moment of the range, else the first one recorded after the range starts.
export function frameAt(
  model: SessionModel,
  atMs: number,
  range: TrimRange,
  screen: ScreenName,
): string | null {
  const at = clamp(atMs, range.fromMs, range.toMs);
  return (
    observeAt(model, at, screen)?.frameId ??
    model.observes.find(
      (entry) => entry.t >= range.fromMs && (entry.screen ?? "desktop") === screen,
    )?.frameId ??
    null
  );
}
