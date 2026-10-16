import { type LocalDotEvent, ULID_PATTERN } from "@localdot/protocol";
import { emptyModel, foldEvents, type SessionModel } from "@localdot/stage";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentFeed, AgentWords } from "../agent/model.ts";
import { createAgentFeed } from "../agent/reducer.ts";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { onForeground } from "../lib/foreground.ts";
import { openSocket, type SocketHandle } from "../lib/socket.ts";
import { readTaskHistory } from "../replay/useReplay.ts";
import type { StageHandle } from "../stage/Stage.tsx";
import { type SessionClock, syncClock } from "./clock-sync.ts";

export interface LiveSession {
  sessionId: string | null;
  agentFeed: AgentFeed & AgentWords;
  model: SessionModel;
  version: number;
  // The daemon's clock for this task, once synced.
  clock: SessionClock | null;
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

// A word for a message already on show changes only that message, which reads it from the feed;
// anything else (a new message, a new line for dot to say) draws the page again.
function wordsOnly(
  event: LocalDotEvent,
  known: ReadonlyMap<string, unknown>,
  model: SessionModel,
  lines: number,
): boolean {
  return (
    event.type === "message.delta" &&
    known.has(event.data.messageId) &&
    saidLines(model, event.data.messageId) === lines
  );
}

const saidLines = (model: SessionModel, id: string) =>
  model.said.findLast((entry) => entry.id === id)?.lines.length ?? 0;

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
  // Read at the next render: the HUD re-reads each second anyway.
  const clock = useRef<SessionClock | null>(null);
  const modelRef = useRef<SessionModel>(emptyModel());
  // The render that adopts a new session runs before the effect that resets the model.
  const modelOwner = useRef<string | null>(null);
  const dirty = useRef(false);
  const words = useRef(false);
  const cellId = cell?.id ?? null;
  const ready = cell?.state === "ready";
  const sessionId =
    shown && (!shown.live || shown.cellId === cellId || resting !== undefined)
      ? shown.sessionId
      : null;
  const previousCell = useRef(cellId);
  const lookNow = useRef(() => {});
  // A task that has ended never runs again, whatever a slower answer says.
  const over = useRef(new Set<string>());

  useEffect(() => {
    if (previousCell.current === cellId) return;
    previousCell.current = cellId;
    // The computer can disappear temporarily during restart/update. History belongs to the
    // conversation, not the physical connection; keep it visible while rediscovering ownership.
    setShown((now) =>
      resting === undefined ? null : now?.live ? { ...now, cellId: null, live: false } : now,
    );
  }, [cellId, resting]);

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
    // A successful choice retired the previous task on the daemon. Its final poll
    // or delayed end event cannot reclaim the newly selected conversation.
    if (resting !== undefined) {
      applied.current = resting;
      setKnown(true);
      setShown((now) => {
        if (now?.live && now.sessionId !== resting) over.current.add(now.sessionId);
        return resting ? { sessionId: resting, cellId: null, live: false } : null;
      });
    }
    lookNow.current();
  }, [choice, resting]);

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
      if (cancelled || polling || document.visibilityState === "hidden") return;
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
          if (!document.hidden)
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
    const stopForeground = onForeground(() => lookNow.current());
    const hide = () => {
      if (document.visibilityState === "hidden") clearTimeout(timer);
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      stopForeground();
      cancelled = true;
      clearTimeout(timer);
      lookNow.current = () => {};
    };
  }, [api, cellId, ready]);

  useEffect(() => {
    const prior = agentFeed.read();
    if (prior.sessionId !== sessionId) {
      agentFeed.reset(cellId, sessionId);
      modelRef.current = emptyModel();
      modelOwner.current = sessionId;
      stage.current?.resetSession();
      setEnded(false);
      clock.current = null;
      setVersion((v) => v + 1);
    }
    if (prior.cellId !== cellId) agentFeed.bindCell(cellId);
    if (!sessionId) return;
    // Same-session history survives API replacement; transport readiness never does.
    agentFeed.connection("connecting");
    let socket: SocketHandle | undefined;
    let repairTimer: ReturnType<typeof setTimeout> | undefined;
    let repairDelay = 500;
    let closed = false;
    let disposed = false;
    let syncing = false;
    const origin = api.socketUrl("").replace(/^ws/, "http");
    // The API's own fetch (injected in tests); a failed sync keeps the last clock and retries on
    // the timer instead of surfacing as an unhandled rejection.
    const sync = async () => {
      if (syncing || document.visibilityState === "hidden") return;
      syncing = true;
      try {
        const [viewer, session] = await Promise.all([
          syncClock(api.fetch, origin, api.token),
          api.get<{ originMicros: number }>(`/api/sessions/${sessionId}/clock`),
        ]);
        if (!disposed) {
          const synced = { offsetMicros: viewer.offsetMicros, originMicros: session.originMicros };
          stage.current?.setClock(synced);
          clock.current = synced;
        }
      } catch (err) {
        if (!disposed)
          console.warn(`clock sync failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        syncing = false;
      }
    };
    let clockTimer: ReturnType<typeof setInterval> | undefined;
    let flush: ReturnType<typeof setInterval> | undefined;
    const flushNow = () => {
      if (document.visibilityState === "hidden") return;
      if (dirty.current) {
        dirty.current = false;
        words.current = false;
        setVersion((v) => v + 1);
      } else if (words.current) {
        words.current = false;
        agentFeed.words();
      }
    };
    const activity = () => {
      clearInterval(clockTimer);
      clearInterval(flush);
      if (document.visibilityState === "hidden") return;
      void sync();
      flushNow();
      clockTimer = setInterval(() => void sync(), CLOCK_EVERY_MS);
      flush = setInterval(flushNow, REACT_HZ_MS);
    };
    document.addEventListener("visibilitychange", activity);
    activity();
    // The task's history arrives whole, so the thread draws it at once; the live feed then goes on
    // from its last event, which it sends again to confirm it holds the same history.
    const reading = new AbortController();
    const live = () => {
      if (disposed) return;
      socket = openSocket({
        url: () => {
          const through = agentFeed.read().model.lastSeq;
          const from = through > 0 ? `?fromSeq=${through}` : "";
          return api.socketUrl(`/api/sessions/${sessionId}/stream${from}`);
        },
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
            const known = agentFeed.read().model.messages;
            const event = agentFeed.accept(data);
            if (!event) {
              // A missing event used to fence the feed forever while its socket stayed
              // open. Replay from the last accepted sequence, with bounded backoff.
              if (agentFeed.read().streamError && !repairTimer) {
                repairTimer = setTimeout(() => {
                  repairTimer = undefined;
                  if (disposed || closed || !agentFeed.read().streamError) return;
                  socket?.close();
                  agentFeed.connection("lost");
                  live();
                }, repairDelay);
                repairDelay = Math.min(5000, repairDelay * 2);
              }
              return;
            }
            if (!agentFeed.read().streamError) {
              clearTimeout(repairTimer);
              repairTimer = undefined;
              repairDelay = 500;
            }
            const lines =
              event.type === "message.delta"
                ? saidLines(modelRef.current, event.data.messageId)
                : 0;
            foldEvents(modelRef.current, [event]);
            stage.current?.pushEvents([event]);
            // dot's thoughts change nothing the page shows.
            if (wordsOnly(event, known, modelRef.current, lines)) words.current = true;
            else if (event.type !== "thought.delta") dirty.current = true;
            if (event.type === "session.end") end();
          },
        },
      });
    };
    const end = () => {
      closed = true;
      clearTimeout(repairTimer);
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
          words.current = false;
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
      clearTimeout(repairTimer);
      document.removeEventListener("visibilitychange", activity);
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
    clock: owned ? clock.current : null,
    ended: owned && (ended || atRest),
    resting: atRest,
    known,
    stop,
    check,
  };
}
