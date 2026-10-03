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
}

const POLL_MS = 1000;
const REACT_HZ_MS = 100;
const CLOCK_EVERY_MS = 20_000;

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
  const dirty = useRef(false);
  const cellId = cell?.id ?? null;
  const ready = cell?.state === "ready";
  const sessionId = identity?.cellId === cellId ? (identity?.sessionId ?? null) : null;
  const previousCell = useRef(cellId);

  useEffect(() => {
    if (previousCell.current === cellId) return;
    previousCell.current = cellId;
    modelRef.current = emptyModel();
    dirty.current = false;
    stage.current?.resetSession();
    setIdentity(null);
    setEnded(false);
    setVersion((v) => v + 1);
  }, [cellId, stage]);

  // Looks for a live session while there is none or the shown one has ended; an ended session
  // stays on screen until the cell starts another.
  useEffect(() => {
    if (!cellId || !ready || (sessionId && !ended)) return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const live = await api.get<{ sessionId: string }>(`/api/cells/${cellId}/live`);
        if (
          !cancelled &&
          typeof live.sessionId === "string" &&
          ULID_PATTERN.test(live.sessionId) &&
          live.sessionId !== sessionId
        )
          setIdentity({ cellId, sessionId: live.sessionId });
      } catch {
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, cellId, ready, sessionId, ended]);

  useEffect(() => {
    const prior = agentFeed.read();
    if (prior.cellId !== cellId || prior.sessionId !== sessionId) {
      agentFeed.reset(cellId, sessionId);
      modelRef.current = emptyModel();
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

  return { sessionId, agentFeed, model: modelRef.current, version, ended, stop };
}
