import type { ScreenSelectionSnapshot } from "@localdot/protocol";
import { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { openSocket } from "../lib/socket.ts";
import { parseCell } from "./parse.ts";
import type { CellSummary } from "./types.ts";

interface BrowserOwner {
  api: ApiClient;
  parentId: string | undefined;
  createdAt: string | undefined;
  scale: number | undefined;
  available: boolean;
  id: string | undefined;
  revision: number | undefined;
}

// A control revision changes input authority, not the physical browser being watched.
// Keep its verified picture while renewing status, without carrying input readiness.
function sameBrowser(a: BrowserOwner, b: BrowserOwner): boolean {
  return (
    a.api === b.api &&
    a.parentId === b.parentId &&
    a.createdAt === b.createdAt &&
    a.scale === b.scale &&
    a.available &&
    b.available &&
    !!a.id &&
    a.id === b.id
  );
}

// A browser has its own status feed. A ready desktop is never evidence of a ready browser. While
// that feed reconnects, the last browser it verified stays on screen but is stale: input waits for
// a fresh status, the picture does not.
export function useBrowserScreen(
  api: ApiClient,
  parent: CellSummary | null,
  selection?: ScreenSelectionSnapshot,
) {
  const parentId = parent?.id;
  const createdAt = parent?.createdAt;
  const scale = parent?.scale;
  const available =
    parent?.state === "ready" && !parent.paused && !parent.fenced && !parent.replacementPending;
  const id = selection?.screen === "browser" ? selection.cellId : undefined;
  const revision = selection?.revision;
  const owner = useMemo(
    () => ({ api, parentId, createdAt, scale, available, id, revision }),
    [api, parentId, createdAt, scale, available, id, revision],
  );
  const [view, setView] = useState<{
    owner: typeof owner;
    cell: CellSummary | null;
    stale: boolean;
    reconnects: number;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!id || !parentId || id === parentId || !available) return;
    let closed = false;
    let opened = false;
    let reconnects = 0;
    const abort = new AbortController();
    const clear = (error: string | null) => {
      if (!closed) setView({ owner, cell: null, stale: false, reconnects, error });
    };
    const hold = (error: string | null) => {
      if (closed) return;
      setView((last) => {
        const cell = last && sameBrowser(last.owner, owner) ? last.cell : null;
        return { owner, cell, stale: !!cell, reconnects, error };
      });
    };
    const socket = openSocket({
      url: api.socketUrl(`/api/browsers/${id}/status`),
      protocols: api.socketProtocols(),
      handlers: {
        onMessage(data) {
          if (closed) return;
          try {
            const cell = parseCell(JSON.parse(data), id);
            if (cell.scale !== scale || cell.createdAt !== createdAt)
              throw new Error("Browser owner changed");
            setView({ owner, cell, stale: false, reconnects, error: null });
          } catch {
            clear("Browser status could not be verified. Reconnecting…");
          }
        },
        onOpen() {
          if (opened) reconnects++;
          opened = true;
          hold(null);
        },
        onClose: () => hold("Browser connection interrupted. Reconnecting…"),
        onRefused() {
          // The WebSocket API hides refusal codes. This authenticated read detects revoked
          // install tokens; only a new status stream can restore display/input readiness.
          void api.get(`/api/browsers/${id}`, { signal: abort.signal }).catch(() => {});
        },
      },
    });
    return () => {
      closed = true;
      abort.abort();
      socket.close();
    };
  }, [api, available, createdAt, id, owner, parentId, scale]);
  if (view?.owner === owner && available && id) return view;
  if (view?.cell && sameBrowser(view.owner, owner)) return { ...view, owner, stale: true };
  return { cell: null, stale: false, reconnects: 0, error: null };
}
