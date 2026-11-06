import { useLayoutEffect, useMemo, useState } from "react";

export const HISTORY_PAGE_ROWS = 100;
interface Page<T> {
  owner: string;
  anchor: string | null;
  // How many rows the page holds, at least the size asked for.
  size: number;
  snapshot: readonly T[];
}
// The rows a move must leave on the page, by key: those within reach of the reader's view.
export interface KeptRows {
  first?: string;
  last?: string;
}
// Render one measured page rather than keeping offscreen Markdown/output trees mounted. A reader's
// explicit page remains anchored while the live projection receives more events. A move adds `step`
// rows at one end and lets go of as many at the other, past the rows it is told to keep, so what the
// reader can see is never taken out and the page never bounces between its ends.
export function usePagedRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  owner = "",
  { size = HISTORY_PAGE_ROWS, step = size }: { size?: number; step?: number } = {},
) {
  const [page, setPage] = useState<Page<T>>({ owner, anchor: null, size, snapshot: [] });
  useLayoutEffect(() => {
    if (page.owner !== owner) setPage({ owner, anchor: null, size, snapshot: [] });
  }, [owner, page.owner, size]);
  const current = useMemo(() => {
    const anchor = page.owner === owner ? page.anchor : null;
    const held = page.owner === owner ? page.size : size;
    const at = (key: string) => rows.findIndex((row) => keyOf(row) === key);
    let start = anchor === null ? Math.max(0, rows.length - held) : at(anchor);
    // The row the page starts on left the thread: it starts on the next of its rows still there.
    if (start < 0)
      for (const row of page.snapshot) {
        start = at(keyOf(row));
        if (start >= 0) break;
      }
    const visible = start < 0 ? page.snapshot : rows.slice(start, start + held);
    return { rows: visible, start, following: anchor === null, retained: start < 0 };
  }, [owner, page, rows, keyOf, size]);
  const end = current.start + current.rows.length;
  const indexOf = (key: string | undefined) =>
    key === undefined ? -1 : rows.findIndex((row) => keyOf(row) === key);
  const hold = (start: number, stop: number) => {
    const next = rows.slice(start, stop);
    setPage({
      owner,
      anchor: next[0] ? keyOf(next[0]) : null,
      size: Math.max(size, next.length),
      snapshot: next,
    });
  };
  return {
    ...current,
    total: rows.length,
    hasOlder: current.start > 0,
    hasNewer: current.retained || end < rows.length,
    freeze: () => {
      if (current.following && current.rows[0])
        setPage({
          owner,
          anchor: keyOf(current.rows[0]),
          size: page.owner === owner ? page.size : size,
          snapshot: current.rows,
        });
    },
    // More of the newest rows, for a thread too short to scroll back through.
    fill: () => {
      if (current.following)
        setPage({ owner, anchor: null, size: end - current.start + step, snapshot: [] });
    },
    older: (keep: KeptRows = {}) => {
      if (current.retained) return;
      const start = Math.max(0, current.start - step);
      hold(start, Math.min(end, Math.max(start + size, indexOf(keep.last) + 1)));
    },
    newer: (keep: KeptRows = {}) => {
      if (current.retained) {
        setPage({ owner, anchor: null, size, snapshot: [] });
        return;
      }
      const stop = Math.min(rows.length, end + step);
      const kept = indexOf(keep.first);
      const start = Math.min(current.start + step, stop - size, kept < 0 ? rows.length : kept);
      hold(Math.max(0, start), stop);
    },
    // The newest rows, and any from the row given on, so a page reached by scrolling loses none of
    // what is in view.
    latest: (keep: KeptRows = {}) => {
      const kept = indexOf(keep.first);
      setPage({
        owner,
        anchor: null,
        size: Math.max(size, kept < 0 ? 0 : rows.length - kept),
        snapshot: [],
      });
    },
  };
}
