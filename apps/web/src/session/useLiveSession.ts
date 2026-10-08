import { ULID_PATTERN } from "@localdot/protocol";
import { emptyModel, foldEvents, type SessionModel } from "@localdot/stage";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { AgentFeed } from "../agent/model.ts";
import { createAgentFeed } from "../agent/reducer.ts";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { openSocket, type SocketHandle } from "../lib/socket.ts";
import type { StageHandle } from "../stage/Stage.tsx";
import { syncClock } from "./clock-sync.ts";

export interface LiveSession {
  sessionId: string | null;
  agentFeed: AgentFeed;
  model: SessionModel;
  version: number;
  ended: boolean;
  stop(): void;
  check(): void;
}

const POLL_MS = 1000;
const IDLE_POLL_MS = 5000;
const QUICK_POLLS = 5;
const REACT_HZ_MS = 100;
const CLOCK_EVERY_MS = 20_000;
const NO_MODEL = emptyModel();

// The worker gets every event at once; React sees the model at most ten times a second.
export function useLiveSession(
  api: ApiClient,
  cell: CellSummary | null,
  stage: RefObject<StageHandle | null>,
): LiveSession {
  const [identity, setIdentity] = useState<{ cellId: string; sessionId: string } | null>(null);
  const [agentFeed] = useState(createAgentFeed);
  const [version, setVersion] = useState(0);
  const [ended, setEnded] = useState(false);
  const modelRef = useRef<SessionModel>(emptyModel());
  // The render that adopts a new session runs before the effect that resets the model.
  const modelOwner = useRef<string | null>(null);
  const dirty = useRef(false);
  const cellId = cell?.id ?? null;
  const ready = cell?.state === "ready";
  const sessionId = identity?.cellId === cellId ? (identity?.sessionId ?? null) : null;
  const previousCell = useRef(cellId);
  const lookNow = useRef(() => {});

  useEffect(() => {
    if (previousCell.current === cellId) return;
    previousCell.current = cellId;
    modelRef.current = emptyModel();
    modelOwner.current = null;
    dirty.current = false;
    stage.current?.resetSession();
    setIdentity(null);
    setEnded(false);
    setVersion((v) => v + 1);
  }, [cellId, stage]);

  // Looks for a live session while there is none or the shown one has ended; an ended session
  // stays on screen until the cell starts another. An idle computer is checked less often.
  useEffect(() => {
    if (!cellId || !ready || (sessionId && !ended)) return;
    let cancelled = false;
    let polling = false;
    let misses = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const live = await api.get<{ sessionId: string } | undefined>(`/api/cells/${cellId}/live`);
        if (
          !cancelled &&
          typeof live?.sessionId === "string" &&
          ULID_PATTERN.test(live.sessionId) &&
          live.sessionId !== sessionId
        )
          setIdentity({ cellId, sessionId: live.sessionId });
      } catch {
      } finally {
        polling = false;
        misses++;
        if (!cancelled) timer = setTimeout(poll, misses < QUICK_POLLS ? POLL_MS : IDLE_POLL_MS);
      }
    };
    lookNow.current = () => {
      misses = 0;
      if (polling) return;
      clearTimeout(timer);
      void poll();
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      lookNow.current = () => {};
    };
  }, [api, cellId, ready, sessionId, ended]);

  useEffect(() => {
    const prior = agentFeed.read();
    if (prior.cellId !== cellId || prior.sessionId !== sessionId) {
      agentFeed.reset(cellId, sessionId);
      modelRef.current = emptyModel();
      modelOwner.current = sessionId;
      stage.current?.resetSession();
      setEnded(false);
      setVersion((v) => v + 1);
    }
    if (!sessionId) return;
    // Same-session history survives API replacement; transport readiness never does.
    agentFeed.connection("connecting");
    let socket: SocketHandle | undefined;
    let closed = false;
    let disposed = false;
    let syncing = false;
    const origin = api.socketUrl("").replace(/^ws/, "http");
    // The API's own fetch (injected in tests); a failed sync keeps the last clock and retries on
    // the timer instead of surfacing as an unhandled rejection.
    const clock = async () => {
      if (syncing) return;
      syncing = true;
      try {
        const [viewer, session] = await Promise.all([
          syncClock(api.fetch, origin, api.token),
          api.get<{ originMicros: number }>(`/api/sessions/${sessionId}/clock`),
        ]);
        if (!disposed)
          stage.current?.setClock({
            offsetMicros: viewer.offsetMicros,
            originMicros: session.originMicros,
          });
      } catch (err) {
        if (!disposed)
          console.warn(`clock sync failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        syncing = false;
      }
    };
    void clock();
    const clockTimer = setInterval(() => void clock(), CLOCK_EVERY_MS);
    const flush = setInterval(() => {
      if (dirty.current) {
        dirty.current = false;
        setVersion((v) => v + 1);
      }
    }, REACT_HZ_MS);
    socket = openSocket({
      url: api.socketUrl(`/api/sessions/${sessionId}/stream`),
      protocols: api.socketProtocols(),
      handlers: {
        onOpen: () => {
          if (!disposed) agentFeed.connection("live");
        },
        onClose: () => {
          if (!disposed && !closed) agentFeed.connection("lost");
        },
        onMessage: (data) => {
          if (disposed) return;
          const event = agentFeed.accept(data);
          if (!event) return;
          foldEvents(modelRef.current, [event]);
          stage.current?.pushEvents([event]);
          dirty.current = true;
          if (event.type === "session.end") {
            closed = true;
            agentFeed.connection("ended");
            socket?.close();
            setEnded(true);
          }
        },
      },
    });
    return () => {
      disposed = true;
      clearInterval(clockTimer);
      clearInterval(flush);
      if (!closed) socket?.close();
    };
  }, [api, cellId, sessionId, stage, agentFeed]);

  const stop = useCallback(() => {
    if (sessionId) void api.post(`/api/sessions/${sessionId}/stop`).catch(() => {});
  }, [api, sessionId]);
  const check = useCallback(() => lookNow.current(), []);

  const owned = modelOwner.current === sessionId;
  return {
    sessionId,
    agentFeed,
    model: owned ? modelRef.current : NO_MODEL,
    version,
    ended: owned && ended,
    stop,
    check,
  };
}
