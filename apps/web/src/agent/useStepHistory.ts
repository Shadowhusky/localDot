import { useCallback, useMemo, useState } from "react";

const BATCH = 100;
// Start at the live end. Scrolling up prepends summaries without replacing rows already being
// read, so long tasks need not mount thousands of rows just to open Activity.
export function useStepHistory<T>(rows: readonly T[], key: (row: T) => string, owner: string) {
  const [held, setHeld] = useState<{ owner: string; first: string } | null>(null);
  const at = held?.owner === owner ? rows.findIndex((row) => key(row) === held.first) : -1;
  const start = at >= 0 ? at : Math.max(0, rows.length - BATCH);
  const hold = useCallback(
    (index: number) => {
      const row = rows[index];
      if (row) setHeld({ owner, first: key(row) });
    },
    [rows, key, owner],
  );
  const visible = useMemo(() => rows.slice(start), [rows, start]);
  const freeze = useCallback(() => {
    if (at < 0) hold(start);
  }, [at, hold, start]);
  return {
    rows: visible,
    hasOlder: start > 0,
    freeze,
    older: () => hold(Math.max(0, start - BATCH)),
  };
}
