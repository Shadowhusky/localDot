import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";

// How often the stage asks whether a window covers the computer's dock, while it shows the desktop.
export const DOCK_ASK_MS = 1000;

export interface DockReading {
  // An application window lies over the desktop's dock: null until the computer has said, or while
  // it can't, when the stage's item keeps out of the way as if covered.
  covered: boolean | null;
  // The web browser is running, so the item has a window to bring forward: null from a computer
  // that doesn't say, when the item stands as it always has.
  browser: boolean | null;
  // How many apps the desktop's dock pins, which the item lines up after: null from a computer
  // that doesn't say, whose dock pins the nine it always has.
  items: number | null;
}
const UNREAD: DockReading = { covered: null, browser: null, items: null };

// What the stage's own item in the desktop's dock goes by.
export function useDockCovered(api: ApiClient, cellId: string | null): DockReading {
  const [state, setState] = useState<({ cellId: string } & DockReading) | null>(null);
  // An answer from before the stage last looked away says nothing of the desktop now.
  if (!cellId && state) setState(null);
  useEffect(() => {
    if (!cellId) return;
    let closed = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: AbortController | undefined;
    const ask = () => {
      clearTimeout(timer);
      if (closed || busy || document.hidden) return;
      busy = true;
      reading = new AbortController();
      api
        .get<{ covered?: unknown; browser?: unknown; items?: unknown }>(
          `/api/cells/${cellId}/dock`,
          {
            signal: reading.signal,
          },
        )
        .then(
          ({ covered, browser, items }): DockReading => ({
            covered: typeof covered === "boolean" ? covered : null,
            browser: typeof browser === "boolean" ? browser : null,
            items: Number.isInteger(items) && (items as number) > 0 ? (items as number) : null,
          }),
          () => UNREAD,
        )
        .then((read) => {
          busy = false;
          if (closed) return;
          setState((was) =>
            was?.cellId === cellId &&
            was.covered === read.covered &&
            was.browser === read.browser &&
            was.items === read.items
              ? was
              : { cellId, ...read },
          );
          timer = setTimeout(ask, DOCK_ASK_MS);
        });
    };
    const shown = () => {
      if (!document.hidden) ask();
    };
    document.addEventListener("visibilitychange", shown);
    ask();
    return () => {
      closed = true;
      clearTimeout(timer);
      reading?.abort();
      document.removeEventListener("visibilitychange", shown);
    };
  }, [api, cellId]);
  return cellId && state?.cellId === cellId ? state : UNREAD;
}
