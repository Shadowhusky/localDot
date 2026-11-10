import type { ConversationRow, ConversationStatus } from "../agent/conversation-list.ts";

export type OverviewFilter = "all" | "working" | "needs-you";
export type OverviewDensity = "s" | "m" | "l";

export const OVERVIEW_FILTERS: readonly OverviewFilter[] = ["all", "working", "needs-you"];
export const OVERVIEW_DENSITIES: readonly OverviewDensity[] = ["s", "m", "l"];

// The narrowest a tile may be at each size: small fits two across a phone, large two beside
// Studio's rail on a laptop.
export const TILE_MIN: Record<OverviewDensity, number> = { s: 156, m: 264, l: 400 };
export const TILE_GAP: Record<OverviewDensity, number> = { s: 12, m: 16, l: 20 };

// Conversations that ended longer ago than this are in the list and Replay, not here.
export const RECENT_MS = 24 * 3_600_000;

// Needs you first, then those at work, then the rest under way, then those that have ended.
const RANK: Record<ConversationStatus, number> = {
  "needs-you": 0,
  working: 1,
  waiting: 2,
  paused: 3,
  idle: 4,
  failed: 5,
  done: 6,
  stopped: 6,
};

export const isWorking = (status: ConversationStatus) =>
  status === "working" || status === "waiting";

// Every conversation under way, and those that ended in the last day, in the order the overview
// shows them: by urgency, pinned ones first within each, then as the list has them, newest first.
export function overviewRows(rows: readonly ConversationRow[], now: number): ConversationRow[] {
  return rows
    .map((row, at) => ({ row, at }))
    .filter(
      ({ row }) =>
        row.active ||
        row.entry.pinned ||
        now - new Date(row.entry.startedAt).getTime() <= RECENT_MS,
    )
    .sort(
      (a, b) =>
        RANK[a.row.status] - RANK[b.row.status] ||
        Number(!!b.row.entry.pinned) - Number(!!a.row.entry.pinned) ||
        a.at - b.at,
    )
    .map(({ row }) => row);
}

export function filterRows(
  rows: readonly ConversationRow[],
  filter: OverviewFilter,
): ConversationRow[] {
  if (filter === "all") return [...rows];
  return rows.filter((row) =>
    filter === "needs-you" ? row.status === "needs-you" : isWorking(row.status),
  );
}

export function filterCounts(rows: readonly ConversationRow[]): Record<OverviewFilter, number> {
  return {
    all: rows.length,
    working: rows.filter((row) => isWorking(row.status)).length,
    "needs-you": rows.filter((row) => row.status === "needs-you").length,
  };
}

// While the user points at or works in the grid nothing moves under them: the tiles keep the order
// they had, those gone leave, and those new join at the end until the grid is let go.
export function heldOrder(held: readonly string[], next: readonly string[]): string[] {
  const present = new Set(next);
  const kept = held.filter((id) => present.has(id));
  const known = new Set(kept);
  return [...kept, ...next.filter((id) => !known.has(id))];
}

export function columnsFor(width: number, density: OverviewDensity): number {
  const gap = TILE_GAP[density];
  return Math.max(1, Math.floor((width + gap) / (TILE_MIN[density] + gap)));
}

// Where the arrows, Home and End take focus in a grid of `count` tiles `columns` across; undefined
// for any other key. Up and down keep the column, and stop at the first and last rows.
export function moveFocus(
  at: number,
  key: string,
  columns: number,
  count: number,
  rtl = false,
): number | undefined {
  const last = count - 1;
  const step = (by: number) => Math.max(0, Math.min(last, at + by));
  switch (key) {
    case "ArrowRight":
      return step(rtl ? -1 : 1);
    case "ArrowLeft":
      return step(rtl ? 1 : -1);
    case "ArrowDown":
      return at + columns <= last ? at + columns : at;
    case "ArrowUp":
      return at - columns >= 0 ? at - columns : at;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return undefined;
  }
}

// The width of the picture a tile asks for: the replay strip's on a small one, twice that on a
// larger or denser one, and the screenshot itself only for the tile in hand when that is sharper.
export type PictureWidth = 320 | 640 | "full";
export function pictureWidth(cssWidth: number, ratio: number, upgraded: boolean): PictureWidth {
  const device = cssWidth * ratio;
  if (device <= 400) return 320;
  if (device <= 800 || !upgraded) return 640;
  return "full";
}
