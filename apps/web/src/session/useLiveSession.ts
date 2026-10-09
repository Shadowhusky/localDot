import { type LocalDotEvent, ULID_PATTERN } from "@localdot/protocol";
import { emptyModel, foldEvents, type SessionModel } from "@localdot/stage";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentFeed } from "../agent/model.ts";
import { createAgentFeed } from "../agent/reducer.ts";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { openSocket, type SocketHandle } from "../lib/socket.ts";
import { readTaskHistory } from "../replay/useReplay.ts";
import type { StageHandle } from "../stage/Stage.tsx";
import { syncClock } from "./clock-sync.ts";

export interface LiveSession {
  sessionId: string | null;
  agentFeed: AgentFeed;
  model: SessionModel;
  version: number;
  ended: boolean;
  // The task shown is the conversation's latest, and no computer is running it.
  resting: boolean;
  // Which task to show is settled: the conversation is read and the computer has said what it runs.
  known: boolean;
  stop(): void;
  check(): void;
}

const POLL_MS = 1000;
const IDLE_POLL_MS = 5000;
const QUICK_POLLS = 5;
const REACT_HZ_MS = 100;
const CLOCK_EVERY_MS = 20_000;
const NO_MODEL = emptyModel();

// A task at rest whose log stops short of its end (the daemon went away under it) was interrupted,
// from its last moment.
function cutShort(model: SessionModel): SessionModel {
  if (model.ended) return model;
  const t = Math.max(model.startT ?? 0, ...model.agentStates.map((state) => state.t));
  return { ...model, ended: { t, reason: "interrupted" } };
}

interface Shown {
  sessionId: string;
  // The computer running it, while it is live.
  cellId: string | null;
  live: boolean;
}

// The worker gets every event at once; React sees the model at most ten times a second.
// The computer's live task is shown while there is one. Otherwise the conversation's latest task,
// `resting` (undefined until known), stays on show as ended, so a refresh, a stopped computer or a
// restarted daemon reopens the conversation rather than an empty page. `choice` counts the
// conversations the user chose (New, Continue).
export function useLiveSession(
  api: ApiClient,
  cell: CellSummary | null,
  stage: RefObject<StageHandle | null>,
  resting?: string | null,
  choice = 0,
): LiveSession {
  const [shown, setShown] = useState<Shown | null>(null);
  const [known, setKnown] = useState(false);
  // The computer that has answered whether it runs a task.
  const [answered, setAnswered] = useState<string | null>(null);
  const [agentFeed] = useState(createAgentFeed);
  const [version, setVersion] = useState(0);
  const [ended, setEnded] = useState(false);
  const modelRef = useRef<SessionModel>(emptyModel());
  // The render that adopts a new session runs before the effect that resets the model.
  const modelOwner = useRef<string | null>(null);
  const dirty = useRef(false);
  const cellId = cell?.id ?? null;
  const ready = cell?.state === "ready";
  const sessionId = shown && (!shown.live || shown.cellId === cellId) ? shown.sessionId : null;
  const previousCell = useRef(cellId);
  const lookNow = useRef(() => {});
  const live = useRef(shown?.live ?? false);
  live.current = shown?.live ?? false;
  // A task that has ended never runs again, whatever a slower answer says.
  const over = useRef(new Set<string>());

  useEffect(() => {
    if (previousCell.current === cellId) return;
    previousCell.current = cellId;
    modelRef.current = emptyModel();
    modelOwner.current = null;
    dirty.current = false;
    stage.current?.resetSession();
    if (live.current) setShown(null);
    setEnded(false);
    setVersion((v) => v + 1);
  }, [cellId, stage]);

  // A conversation chosen anew (a new one, or an older one continued) takes the page once no live
  // task is at work there. On opening, a running computer first says whether it still runs one.
  const applied = useRef<string | null | undefined>(undefined);
  const working = !!shown?.live && !ended;
  const asking = !!cellId && ready && answered !== cellId;
  useEffect(() => {
    if (resting === undefined || resting === applied.current) return;
    if (applied.current === undefined) {
      if (asking) return;
      // A task the computer runs takes the page on opening, and keeps it once it ends.
      if (working) applied.current = resting;
      setKnown(true);
    }
    if (working) return;
    applied.current = resting;
    setShown((now) => {
      if (now?.live) over.current.add(now.sessionId);
      if (now?.sessionId === resting) return now.live ? { ...now, live: false } : now;
      return resting ? { sessionId: resting, cellId: null, live: false } : null;
    });
  }, [resting, working, asking]);

  // Answers about the computer's task asked before the user chose a conversation say nothing
  // about it, so the computer is asked again at once.
  const choices = useRef(0);
  const chosen = useRef(choice);
  useEffect(() => {
    if (chosen.current === choice) return;
    chosen.current = choice;
    choices.current++;
    lookNow.current();
  }, [choice]);

  // Asks the computer for its task: often while it may be starting one, every five seconds
  // otherwise. A task the computer no longer runs stays on show, at rest.
  useEffect(() => {
    if (!cellId || !ready) return;
    let cancelled = false;
    let polling = false;
    let again = false;
    let first = true;
    let misses = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (polling) return;
      polling = true;
      again = false;
      const asked = choices.current;
      try {
        const reply = await api.get<{ sessionId: string } | undefined>(`/api/cells/${cellId}/live`);
        const found =
          typeof reply?.sessionId === "string" &&
          ULID_PATTERN.test(reply.sessionId) &&
          !over.current.has(reply.sessionId)
            ? reply.sessionId
            : null;
        if (!cancelled && asked === choices.current)
          setShown((now) => {
            if (found)
              return now?.live && now.cellId === cellId && now.sessionId === found
                ? now
                : { sessionId: found, cellId, live: true };
            if (!now?.live || now.cellId !== cellId) return now;
            over.current.add(now.sessionId);
            return { ...now, live: false };
          });
      } catch {
      } finally {
        polling = false;
        misses++;
        if (!cancelled) {
          if (first) setAnswered(cellId);
          first = false;
          timer = setTimeout(poll, again ? 0 : misses < QUICK_POLLS ? POLL_MS : IDLE_POLL_MS);
        }
      }
    };
    lookNow.current = () => {
      misses = 0;
      again = polling;
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
  }, [api, cellId, ready]);

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
    // The task's history arrives whole, so the thread draws it at once; the live feed then goes on
    // from its last event, which it sends again to confirm it holds the same history.
    const reading = new AbortController();
    const live = () => {
      if (disposed) return;
      const through = agentFeed.read().model.lastSeq;
      const from = through > 0 ? `?fromSeq=${through}` : "";
      socket = openSocket({
        url: api.socketUrl(`/api/sessions/${sessionId}/stream${from}`),
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
            if (event.type === "session.end") end();
          },
        },
      });
    };
    const end = () => {
      closed = true;
      over.current.add(sessionId);
      agentFeed.connection("ended");
      socket?.close();
      setEnded(true);
    };
    if (agentFeed.read().history) live();
    else {
      const events: LocalDotEvent[] = [];
      readTaskHistory(api, sessionId, reading.signal, (batch) => {
        for (const event of batch) events.push(event);
      }).then(
        () => {
          if (disposed) return;
          agentFeed.load(events);
          foldEvents(modelRef.current, events);
          stage.current?.pushEvents(events);
          dirty.current = false;
          setVersion((v) => v + 1);
          if (agentFeed.read().model.ended) end();
          else live();
        },
        () => live(),
      );
    }
    return () => {
      disposed = true;
      reading.abort();
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
  const atRest = !!sessionId && !shown?.live;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the model is folded in place, so its version is what changes
  const model = useMemo(
    () => (!owned ? NO_MODEL : atRest ? cutShort(modelRef.current) : modelRef.current),
    [owned, atRest, version],
  );
  return {
    sessionId,
    agentFeed,
    model,
    version,
    ended: owned && (ended || atRest),
    resting: atRest,
    known,
    stop,
    check,
  };
}
