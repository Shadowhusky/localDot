import type { AttentionItem } from "@localdot/protocol";
import { useEffect, useRef } from "react";
import type { ApiClient } from "../lib/api.ts";
import { notifyApi } from "../notify/notify-api.ts";

export interface SeenHost {
  doc: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener">;
  win: Pick<Window, "addEventListener" | "removeEventListener">;
}

// Tells the daemon a Done or Failed task was seen once it is on screen in a visible, focused tab,
// so badges and titles clear everywhere. Each item is reported once.
export function useSeenReporting(
  api: ApiClient,
  items: readonly AttentionItem[],
  viewing: string | null,
  host?: SeenHost,
): void {
  const reported = useRef(new Set<string>());
  useEffect(() => {
    const { doc, win } = host ?? { doc: document, win: window };
    const check = () => {
      if (!viewing || doc.visibilityState !== "visible" || !doc.hasFocus()) return;
      const item = items.find((open) => open.sessionId === viewing);
      if (!item || (item.level !== "done" && item.level !== "failed")) return;
      if (reported.current.has(item.key)) return;
      reported.current.add(item.key);
      notifyApi(api)
        .seen(viewing)
        .catch(() => reported.current.delete(item.key));
    };
    check();
    doc.addEventListener("visibilitychange", check);
    win.addEventListener("focus", check);
    return () => {
      doc.removeEventListener("visibilitychange", check);
      win.removeEventListener("focus", check);
    };
  }, [api, items, viewing, host]);
}
