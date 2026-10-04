import { useLayoutEffect, useMemo, useState } from "react";

export const HISTORY_PAGE_ROWS = 100;
interface Page<T> {
  owner: string;
  anchor: string | null;
  snapshot: readonly T[];
}
// Render one measured page rather than keeping offscreen Markdown/output trees mounted.
// A reader's explicit page remains anchored while the live projection receives more events.
export function usePagedRows<T>(rows: readonly T[], keyOf: (row: T) => string, owner = "") {
  const [page, setPage] = useState<Page<T>>({ owner, anchor: null, snapshot: [] });
  useLayoutEffect(() => {
    if (page.owner !== owner) setPage({ owner, anchor: null, snapshot: [] });
  }, [owner, page.owner]);
  const current = useMemo(() => {
    const anchor = page.owner === owner ? page.anchor : null;
    const found = anchor === null ? -1 : rows.findIndex((row) => keyOf(row) === anchor);
    const start = anchor === null ? Math.max(0, rows.length - HISTORY_PAGE_ROWS) : found;
    const visible = start < 0 ? page.snapshot : rows.slice(start, start + HISTORY_PAGE_ROWS);
    return { rows: visible, start, following: anchor === null, retained: start < 0 };
  }, [owner, page, rows, keyOf]);
  const move = (start: number) => {
    const next = rows.slice(Math.max(0, start), Math.max(0, start) + HISTORY_PAGE_ROWS);
    setPage({ owner, anchor: next[0] ? keyOf(next[0]) : null, snapshot: next });
  };
  return {
    ...current,
    total: rows.length,
    hasOlder: current.start > 0,
    hasNewer: current.retained || current.start + current.rows.length < rows.length,
    freeze: () => {
      if (current.following && current.rows[0])
        setPage({ owner, anchor: keyOf(current.rows[0]), snapshot: current.rows });
    },
    older: () => move(Math.max(0, current.start - HISTORY_PAGE_ROWS)),
    newer: () => {
      if (current.retained || current.start + 2 * HISTORY_PAGE_ROWS >= rows.length)
        setPage({ owner, anchor: null, snapshot: [] });
      else move(current.start + HISTORY_PAGE_ROWS);
    },
    latest: () => setPage({ owner, anchor: null, snapshot: [] }),
  };
}
