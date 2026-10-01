import { useCallback, useEffect, useRef, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { forgetOldTickets } from "./client-storage.ts";
import { DesktopFrame } from "./DesktopFrame.tsx";
import { type FrameSource, frameTapSupport } from "./frame-source.ts";
import { StageCanvas, type StageCanvasHandle } from "./StageCanvas.tsx";

export interface StageProps {
  cell: CellSummary | null;
  api: ApiClient;
  // Times the daemon's status socket has reopened: a daemon restart revokes every ticket.
  reconnects: number;
}

interface ClientPage {
  src: string;
  key: string;
}

export function Stage({ cell, api, reconnects }: StageProps) {
  const support = frameTapSupport();
  const canvas = useRef<StageCanvasHandle>(null);
  const [page, setPage] = useState<ClientPage | null>(null);
  const [stale, setStale] = useState(0);
  const cellId = cell?.id ?? null;
  const ready = cell?.state === "ready";

  // The client reloads itself with the same URL, so a ticket that died under it (a daemon restart,
  // or the cell leaving ready unseen) leaves it dead: a new ticket and a fresh client follow every
  // reconnect of the daemon's socket and every client that shows no video for a while.
  useEffect(() => {
    if (!cellId || !ready || !support.ok) {
      setPage(null);
      canvas.current?.detach();
      return;
    }
    let cancelled = false;
    const attempt = `${reconnects}.${stale}`;
    api.post<{ path: string }>(`/api/cells/${cellId}/stream-ticket`).then(
      ({ path }) => {
        if (cancelled) return;
        forgetOldTickets(cellId, path);
        setPage({ src: path, key: `${path}#${attempt}` });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api, cellId, ready, support.ok, reconnects, stale]);

  const onSource = useCallback((source: FrameSource) => {
    const stage = canvas.current;
    if (stage) stage.attach(source);
    else source.stop();
  }, []);
  const onStale = useCallback(() => setStale((n) => n + 1), []);
  const paused =
    cell?.stream.connection === "stalled" || cell?.stream.connection === "disconnected";

  if (!support.ok) {
    return (
      <div className="stage-veil" role="alert">
        <p>{support.reason}</p>
      </div>
    );
  }
  return (
    <>
      <StageCanvas ref={canvas} />
      {page && <DesktopFrame key={page.key} src={page.src} onSource={onSource} onStale={onStale} />}
      <div className={paused ? "stage-veil on" : "stage-veil"} aria-hidden={!paused}>
        <p>Reconnecting…</p>
      </div>
    </>
  );
}
