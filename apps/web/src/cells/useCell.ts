import { ULID_PATTERN } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { openSocket } from "../lib/socket.ts";
import { describeRequestError } from "./errors.ts";
import type { CellStatus, CellView, Pending } from "./hud-state.ts";
import { followOperation, type OperationClock } from "./operation-clock.ts";
import { parseCell, parseCells } from "./parse.ts";
import type { CellState, CellSummary } from "./types.ts";

export interface CellController extends CellView {
  // A refused request in plain words, until the cell's state next changes.
  error: string | null;
  // Every cell id the daemon listed last.
  listed: string[];
  // Times the status socket has reopened after its first open.
  reconnects: number;
  // The start, update or stop going on, anchored when its summary arrived.
  operation: OperationClock | null;
  start(): void;
  stop(): void;
  resume(): void;
  retry(): void;
  selectReady(id: string): Promise<boolean>;
  selectRecovery(id: string): Promise<boolean>;
}

const CELLS = "/api/cells";

// Whether this computer has shown a picture since it last came up. Only the computer going down or
// being replaced clears it: a stream that reconnects does not.
function useStreamed(cell: CellSummary | null): boolean {
  const up = cell?.state === "ready" ? cell.id : null;
  const [seen, setSeen] = useState<string | null>(null);
  if (up && cell?.stream.connection === "live" && seen !== up) setSeen(up);
  else if (seen !== null && seen !== up) setSeen(null);
  return up !== null && (seen === up || cell?.stream.connection === "live");
}

// One computer per install in Part 2: the first cell the daemon lists, created on demand. Until the
// daemon has answered the list, Start is disabled, so it never creates a second computer.
export function useCell(api: ApiClient): CellController {
  const [cell, setCell] = useState<CellSummary | null>(null);
  const [operation, setOperation] = useState<OperationClock | null>(null);
  const [listed, setListed] = useState<string[]>([]);
  const [status, setStatus] = useState<CellStatus>("listing");
  const [pending, setPending] = useState<Pending | null>("list");
  const [error, setError] = useState<string | null>(null);
  const [reconnects, setReconnects] = useState(0);
  const cellId = cell?.id ?? null;
  const streamed = useStreamed(cell);
  const selectedId = useRef<string | null>(null);
  const revision = useRef(0);
  // Read by callbacks that must see the latest value, not the one of their render.
  const pendingRef = useRef<Pending | null>("list");
  const stateRef = useRef<CellState | null>(null);
  const pausedRef = useRef(false);
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
    revision.current++;
    stateRef.current = next?.state ?? null;
    pausedRef.current = !!next?.paused;
    const arrived = Date.now();
    setOperation((last) => followOperation(last, next, arrived));
    setCell(next);
  }, []);

  const adopt = useCallback(
    (cells: CellSummary[]) => {
      const next =
        cells.find((row) => row.id === selectedId.current) ??
        cells.find((row) => !row.fenced && !row.replacementPending && row.state !== "removed") ??
        cells
          .filter((row) => row.state !== "removed")
          .sort((a, b) => b.id.localeCompare(a.id))[0] ??
        cells.at(-1);
      selectedId.current = next?.id ?? null;
      show(next ?? null);
      setListed(cells.map((c) => c.id));
      setStatus("known");
    },
    [show],
  );

  // Lists the cells and adopts the answer; when no answer comes, the computer's state is unknown.
  const relist = useCallback(async () => {
    const at = revision.current;
    try {
      const cells = parseCells(await api.get<unknown>(CELLS));
      if (mounted.current && at === revision.current) adopt(cells);
    } catch (err) {
      if (!mounted.current || at !== revision.current) return;
      setError(describeRequestError(err));
      setStatus("unknown");
    }
  }, [api, adopt]);

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
      const at = revision.current;
      try {
        await api.get("/api/whoami");
        const cells = parseCells(await api.get<unknown>(CELLS));
        if (!closed && selectedId.current === cellId && at === revision.current) adopt(cells);
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
          if (closed || !mounted.current || selectedId.current !== cellId) return;
          let next: CellSummary;
          try {
            next = parseCell(JSON.parse(data), cellId);
          } catch {
            setError("Computer status could not be verified.");
            setStatus("unknown");
            return;
          }
          setStatus("known");
          // A refused request's message lasts until the state it was about moves on.
          if (next.state !== stateRef.current || !!next.paused !== pausedRef.current)
            setError(null);
          // Retirement removes native resources, but a permanent fence still owns recovery.
          // Keep that public identity until the replacement receipt selects a verified Ready owner.
          show(next.state === "removed" && !next.fenced && !next.replacementPending ? null : next);
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
        setError(describeRequestError(err, kind === "resume" ? "resume" : undefined));
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
    if (cell?.fenced || cell?.replacementPending) return;
    if (cellId) {
      void run("start", async () => {
        await api.post(`${CELLS}/${cellId}/start`);
      });
    } else {
      void run("create", async () => {
        const created = await api.post<CellSummary>(CELLS, { scale: 2 });
        if (mounted.current) {
          const next = parseCell(created);
          selectedId.current = next.id;
          show(next);
        }
      });
    }
  }, [api, cellId, cell?.fenced, cell?.replacementPending, run, show]);

  const stop = useCallback(() => {
    if (!cellId) return;
    void run("stop", async () => {
      await api.post(`${CELLS}/${cellId}/stop`);
    });
  }, [api, cellId, run]);

  const resume = useCallback(() => {
    if (!cellId || !cell?.paused || cell.fenced || cell.replacementPending) return;
    void run("resume", async () => {
      await api.post(`${CELLS}/${cellId}/resume`);
    });
  }, [api, cellId, cell?.paused, cell?.fenced, cell?.replacementPending, run]);

  // relist() settles every failure itself: a list that gets no answer leaves the state unknown.
  const retry = useCallback(() => {
    void run("list", relist);
  }, [relist, run]);

  const selectReady = useCallback(
    async (id: string) => {
      if (!ULID_PATTERN.test(id)) return false;
      const owner = selectedId.current;
      try {
        const next = parseCell(await api.get<unknown>(`${CELLS}/${id}`), id);
        if (
          !mounted.current ||
          selectedId.current !== owner ||
          next.state !== "ready" ||
          next.paused ||
          next.fenced ||
          next.replacementPending
        )
          return false;
        selectedId.current = id;
        show(next);
        setStatus("known");
        setError(null);
        return true;
      } catch {
        return false;
      }
    },
    [api, show],
  );
  // Following a historical replacement may lead to a computer with its own fence.
  // Select only its recovery screen; this is never a grant of executable readiness.
  const selectRecovery = useCallback(
    async (id: string) => {
      if (!ULID_PATTERN.test(id)) return false;
      const owner = selectedId.current;
      try {
        const next = parseCell(await api.get<unknown>(`${CELLS}/${id}`), id);
        if (!mounted.current || selectedId.current !== owner || !next.fenced) return false;
        selectedId.current = id;
        show(next);
        setStatus("known");
        setError(null);
        return true;
      } catch {
        return false;
      }
    },
    [api, show],
  );
  return {
    cell,
    status,
    pending,
    streamed,
    error,
    listed,
    reconnects,
    operation,
    start,
    stop,
    resume,
    retry,
    selectReady,
    selectRecovery,
  };
}
