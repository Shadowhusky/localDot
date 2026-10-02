import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { openSocket } from "../lib/socket.ts";
import { describeRequestError } from "./errors.ts";
import type { CellStatus, CellView, Pending } from "./hud-state.ts";
import type { CellState, CellSummary } from "./types.ts";

export interface CellController extends CellView {
  // A refused request in plain words, until the cell's state next changes.
  error: string | null;
  // Every cell id the daemon listed last.
  listed: string[];
  // Times the status socket has reopened after its first open.
  reconnects: number;
  start(): void;
  stop(): void;
  retry(): void;
}

const CELLS = "/api/cells";

// One computer per install in Part 2: the first cell the daemon lists, created on demand. Until the
// daemon has answered the list, Start is disabled, so it never creates a second computer.
export function useCell(api: ApiClient): CellController {
  const [cell, setCell] = useState<CellSummary | null>(null);
  const [listed, setListed] = useState<string[]>([]);
  const [status, setStatus] = useState<CellStatus>("listing");
  const [pending, setPending] = useState<Pending | null>("list");
  const [error, setError] = useState<string | null>(null);
  const [reconnects, setReconnects] = useState(0);
  const cellId = cell?.id ?? null;
  // Read by callbacks that must see the latest value, not the one of their render.
  const pendingRef = useRef<Pending | null>("list");
  const stateRef = useRef<CellState | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const wait = useCallback((next: Pending | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const show = useCallback((next: CellSummary | null) => {
    stateRef.current = next?.state ?? null;
    setCell(next);
  }, []);

  const adopt = useCallback(
    (cells: CellSummary[]) => {
      show(cells[0] ?? null);
      setListed(cells.map((c) => c.id));
      setStatus("known");
    },
    [show],
  );

  // Lists the cells and adopts the answer; when no answer comes, the computer's state is unknown.
  const relist = useCallback(async () => {
    try {
      const cells = await api.get<CellSummary[]>(CELLS);
      if (mounted.current) adopt(cells);
    } catch (err) {
      if (!mounted.current) return;
      setError(describeRequestError(err));
      show(null);
      setStatus("unknown");
    }
  }, [api, adopt, show]);

  useEffect(() => {
    wait("list");
    void relist().finally(() => {
      if (mounted.current) wait(null);
    });
  }, [relist, wait]);

  useEffect(() => {
    if (!cellId) return;
    let opened = false;
    let closed = false;
    let probing = false;
    // A refused socket: a 401 from whoami unmounts this Theatre (the api's onUnauthorized), which
    // closes the socket; a good token means the cell may be gone, so the daemon's list decides.
    const probe = async () => {
      if (probing) return;
      probing = true;
      try {
        await api.get("/api/whoami");
        const cells = await api.get<CellSummary[]>(CELLS);
        if (!closed) adopt(cells);
      } catch {
        // A 401 is handled by the api; without an answer, the socket keeps retrying.
      } finally {
        probing = false;
      }
    };
    const socket = openSocket({
      url: api.socketUrl(`/api/cells/${cellId}/status`),
      protocols: api.socketProtocols(),
      handlers: {
        onMessage: (data) => {
          const next = JSON.parse(data) as CellSummary;
          // A refused request's message lasts until the state it was about moves on.
          if (next.state !== stateRef.current) setError(null);
          show(next.state === "removed" ? null : next);
        },
        onOpen: () => {
          if (opened) setReconnects((n) => n + 1);
          opened = true;
        },
        onRefused: () => void probe(),
      },
    });
    return () => {
      closed = true;
      socket.close();
    };
  }, [api, cellId, adopt, show]);

  const run = useCallback(
    async (kind: Pending, action: () => Promise<void>) => {
      if (pendingRef.current !== null) return;
      wait(kind);
      setError(null);
      try {
        await action();
      } catch (err) {
        if (!mounted.current) return;
        setError(describeRequestError(err));
        // No answer: the daemon may have acted (a create may have saved its record). A 404: the
        // computer is gone. Either way the daemon's list says what is there now.
        if (!(err instanceof ApiError) || err.status === 404) {
          wait("list");
          await relist();
        }
      } finally {
        if (mounted.current) wait(null);
      }
    },
    [relist, wait],
  );

  const start = useCallback(() => {
    if (cellId) {
      void run("start", async () => {
        await api.post(`${CELLS}/${cellId}/start`);
      });
    } else {
      void run("create", async () => {
        const created = await api.post<CellSummary>(CELLS, { scale: 2 });
        if (mounted.current) show(created);
      });
    }
  }, [api, cellId, run, show]);

  const stop = useCallback(() => {
    if (!cellId) return;
    void run("stop", async () => {
      await api.post(`${CELLS}/${cellId}/stop`);
    });
  }, [api, cellId, run]);

  // relist() settles every failure itself: a list that gets no answer leaves the state unknown.
  const retry = useCallback(() => {
    void run("list", relist);
  }, [relist, run]);

  return { cell, status, pending, error, listed, reconnects, start, stop, retry };
}
