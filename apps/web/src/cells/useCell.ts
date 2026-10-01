import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { openSocket } from "../lib/socket.ts";
import type { CellSummary } from "./types.ts";

export interface CellController {
  cell: CellSummary | null;
  busy: boolean;
  error: string | null;
  // Times the status socket has reopened after its first open.
  reconnects: number;
  start(): void;
  stop(): void;
}

// One computer per install in Part 2: the first cell the daemon lists, created on demand. Until the
// daemon has answered the list, the hook reports busy, so Start never creates a second computer.
export function useCell(api: ApiClient): CellController {
  const [cell, setCell] = useState<CellSummary | null>(null);
  const [listed, setListed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnects, setReconnects] = useState(0);
  const cellId = cell?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    api.get<CellSummary[]>("/api/cells").then(
      (cells) => {
        if (cancelled) return;
        setCell(cells[0] ?? null);
        setListed(true);
      },
      (err: Error) => {
        if (!cancelled) setError(err.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!cellId) return;
    let opened = false;
    const socket = openSocket({
      url: api.socketUrl(`/api/cells/${cellId}/status`),
      protocols: api.socketProtocols(),
      handlers: {
        onMessage: (data) => {
          const next = JSON.parse(data) as CellSummary;
          setCell(next.state === "removed" ? null : next);
        },
        onOpen: () => {
          if (opened) setReconnects((n) => n + 1);
          opened = true;
        },
      },
    });
    return () => socket.close();
  }, [api, cellId]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(() => {
    void run(async () => {
      if (cellId) await api.post(`/api/cells/${cellId}/start`);
      else setCell(await api.post<CellSummary>("/api/cells", { scale: 2 }));
    });
  }, [api, cellId, run]);

  const stop = useCallback(() => {
    if (cellId) void run(() => api.post(`/api/cells/${cellId}/stop`));
  }, [api, cellId, run]);

  return { cell, busy: busy || !listed, error, reconnects, start, stop };
}
