import { useCallback, useEffect, useRef, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import type { LiveSession } from "../session/useLiveSession.ts";
import { type AgentSnapshot, loadAgentSnapshot } from "./api.ts";
import { type AgentModel, emptyAgentModel } from "./model.ts";

const EMPTY_AGENT_MODEL = emptyAgentModel();

interface SnapshotView {
  readonly api: ApiClient;
  readonly cellId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly snapshot: AgentSnapshot | null;
  readonly availability: "loading" | "ready" | "missing" | "error";
  readonly error: string | null;
}
export interface AgentSessionView {
  readonly sessionId: string | null;
  readonly model: AgentModel;
  readonly snapshot: AgentSnapshot | null;
  readonly availability: "loading" | "ready" | "missing" | "error";
  readonly error: string | null;
  // Consumers must require this in addition to their action-specific and cell ownership gates.
  // A displayed last-known status is never permission to submit or send desktop input.
  readonly fresh: boolean;
  // A verified terminal snapshot permits memory history actions, never task or desktop input.
  readonly readFresh?: boolean;
  readonly authorityEpoch?: number | null;
  readonly connection: ReturnType<LiveSession["agentFeed"]["read"]>["connection"];
  reconcile(): void;
}
const STATUS_ERROR = "Task status is unavailable. Check the connection and try again.";

// Reads snapshots from the existing event owner. No second socket, optimistic mutation or
// text-based acknowledgement. An invalidation occurs synchronously before a fetch can commit.
export function useAgentSession(
  api: ApiClient,
  cell: CellSummary | null,
  live: LiveSession,
): AgentSessionView {
  const cellId = cell?.id ?? null;
  const sessionId = live.sessionId;
  const feed = live.agentFeed;
  const [view, setView] = useState<SnapshotView | null>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!cellId || !sessionId) {
      setView(null);
      return;
    }
    let disposed = false,
      busy = false,
      queued = false;
    const abort = new AbortController();
    const matches = () => {
      const current = feed.read();
      return !disposed && current.cellId === cellId && current.sessionId === sessionId;
    };
    const poll = async () => {
      if (!matches()) return;
      if (busy) {
        queued = true;
        return;
      }
      busy = true;
      queued = false;
      const epoch = feed.read().epoch;
      try {
        const snapshot = await loadAgentSnapshot(api, sessionId, cellId, abort.signal);
        if (matches() && epoch === feed.read().epoch)
          setView({ api, cellId, sessionId, epoch, snapshot, availability: "ready", error: null });
        else if (matches()) queued = true;
      } catch (error) {
        if (matches() && epoch === feed.read().epoch) {
          const missing = error instanceof ApiError && error.status === 404;
          setView((old) => ({
            api,
            cellId,
            sessionId,
            epoch,
            snapshot:
              old?.api === api && old.cellId === cellId && old.sessionId === sessionId
                ? old.snapshot
                : null,
            availability: missing ? "missing" : "error",
            error: missing ? null : STATUS_ERROR,
          }));
        } else if (matches()) queued = true;
      } finally {
        busy = false;
        if (queued && matches()) void poll();
      }
    };
    const invalidate = () => {
      // The feed epoch also makes freshness false in any render before this state update.
      setView((old) =>
        old && old.api === api && old.cellId === cellId && old.sessionId === sessionId
          ? { ...old, epoch: -1 }
          : {
              api,
              cellId,
              sessionId,
              epoch: -1,
              snapshot: null,
              availability: "loading",
              error: null,
            },
      );
      void poll();
    };
    const unsubscribe = feed.subscribe(invalidate);
    refresh.current = invalidate;
    void poll();
    const timer = setInterval(() => {
      if (!feed.read().model.ended) void poll();
    }, 1000);
    return () => {
      disposed = true;
      abort.abort();
      clearInterval(timer);
      unsubscribe();
      refresh.current = () => {};
    };
  }, [api, cellId, sessionId, feed]);
  const reconcile = useCallback(() => refresh.current(), []);
  const current = feed.read();
  const owned = view?.api === api && view.cellId === cellId && view.sessionId === sessionId;
  const snapshot = owned ? view.snapshot : null;
  const matches = current.cellId === cellId && current.sessionId === sessionId;
  const ownershipAligned =
    (current.model.screen
      ? snapshot?.screen?.screen === current.model.screen.screen &&
        snapshot.screen.cellId === current.model.screen.cellId &&
        snapshot.screen.revision === current.model.screen.revision &&
        snapshot.screen.geometry.w === current.model.screen.geometry.w &&
        snapshot.screen.geometry.h === current.model.screen.geometry.h &&
        snapshot.screen.geometry.scale === current.model.screen.geometry.scale
      : !snapshot?.screen ||
        (snapshot.screen.screen === "desktop" && snapshot.screen.revision === 0)) &&
    (snapshot?.pendingAsk ?? null) === current.model.pendingAsk &&
    (snapshot?.pendingTakeover ?? null) === current.model.pendingTakeover &&
    JSON.stringify(snapshot?.approval ?? null) === JSON.stringify(current.model.approval ?? null) &&
    JSON.stringify(snapshot?.connection ?? null) ===
      JSON.stringify(current.model.connection ?? null) &&
    JSON.stringify(snapshot?.pause ?? null) === JSON.stringify(current.model.safetyPause ?? null);
  const readFresh = Boolean(
    matches &&
      owned &&
      view.availability === "ready" &&
      view.epoch === current.epoch &&
      current.replayed &&
      ownershipAligned &&
      !current.streamError &&
      cell?.state === "ready" &&
      !cell.paused &&
      (current.connection === "live" ||
        (current.connection === "ended" && current.model.ended && snapshot?.status === "ended")),
  );
  return {
    sessionId,
    model: matches ? current.model : EMPTY_AGENT_MODEL,
    snapshot,
    availability: owned ? view.availability : "loading",
    error: current.streamError ?? (owned ? view.error : null),
    authorityEpoch: owned ? view.epoch : null,
    readFresh,
    fresh: Boolean(
      matches &&
        owned &&
        view.availability === "ready" &&
        view.epoch === current.epoch &&
        current.connection === "live" &&
        current.replayed &&
        ownershipAligned &&
        snapshot?.status !== "ended" &&
        !current.streamError &&
        !current.model.ended &&
        cell?.state === "ready" &&
        !cell.paused &&
        !cell.fenced &&
        !cell.replacementPending,
    ),
    connection: matches ? current.connection : "connecting",
    reconcile,
  };
}
