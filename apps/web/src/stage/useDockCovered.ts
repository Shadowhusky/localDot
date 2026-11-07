import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";

// How often the stage asks whether a window covers the computer's dock, while it shows the desktop.
export const DOCK_ASK_MS = 1000;

// Whether an application window lies over the desktop's dock, for the stage's own item in it: null
// until the computer has said, or while it can't, when the item keeps out of the way as if covered.
export function useDockCovered(api: ApiClient, cellId: string | null): boolean | null {
  const [state, setState] = useState<{ cellId: string; covered: boolean | null } | null>(null);
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
        .get<{ covered?: unknown }>(`/api/cells/${cellId}/dock`, { signal: reading.signal })
        .then(
          ({ covered }) => (typeof covered === "boolean" ? covered : null),
          () => null,
        )
        .then((covered) => {
          busy = false;
          if (closed) return;
          setState({ cellId, covered });
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
  return cellId && state?.cellId === cellId ? state.covered : null;
}
