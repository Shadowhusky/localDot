import {
  type LocalDotEvent,
  parseEvent,
  RecordingInfo,
  ScreenName,
  SessionCard,
  sessionMsOf,
  ULID_PATTERN,
} from "@localdot/protocol";
import {
  buildPlaybackMap,
  busySpans,
  chapters,
  emptyModel,
  foldEvents,
  idleAt,
  type PlaybackMap,
  playAt,
  REPLAY_SPEEDS,
  type ReplaySpeed,
  type SessionModel,
  screenAt,
  stepAt,
} from "@localdot/stage";
import { type RefObject, useEffect, useRef, useState } from "react";
import { type AgentModel, emptyAgentModel } from "../agent/model.ts";
import { projectAgentEvent } from "../agent/reducer.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import type { StageHandle } from "../stage/Stage.tsx";
import type { ReplaySource, ReplayStatus } from "../stage/worker-protocol.ts";
import { WorkHistory } from "../work/work-view.ts";
import { recordingSnapshot } from "./recording-source.ts";
import { compareFrames, followRule, type ReplayCommand } from "./replay-view.ts";
import { SeekGate } from "./seek-gate.ts";

export type ReplayScreen = "auto" | ScreenName;

export interface ReplayState {
  sessionId: string | null;
  screen: ScreenName;
  // Auto follows recorded screen.switch events; an explicit choice stays pinned.
  screenChoice: ReplayScreen;
  setScreen(screen: ReplayScreen): void;
  status: ReplayStatus["state"];
  card: SessionCard | null;
  info: RecordingInfo | null;
  model: SessionModel;
  agent: AgentModel;
  work: WorkHistory;
  version: number;
  tMs: number;
  playing: boolean;
  speed: ReplaySpeed;
  skipIdle: boolean;
  idleNow: boolean;
  map: PlaybackMap | null;
  compare: { before: string | null; after: string | null } | null;
  // The stretch marked with I and O, for an export.
  selection: { fromMs: number; toMs: number } | null;
  run(command: ReplayCommand): void;
  seek(tMs: number, mode: "exact" | "preview"): void;
  setSpeed(speed: ReplaySpeed): void;
  setSkipIdle(on: boolean): void;
  selectStep(stepId: string): void;
  // Loads the recording again from the start, after it failed to load.
  retry(): void;
}
type ReplayValues = Omit<
  ReplayState,
  "run" | "seek" | "setSpeed" | "setSkipIdle" | "selectStep" | "setScreen" | "retry"
>;

function initialState(sessionId: string | null): ReplayValues {
  return {
    sessionId,
    screen: "desktop",
    screenChoice: "auto",
    status: "loading",
    card: null,
    info: null,
    model: emptyModel(),
    agent: emptyAgentModel(),
    work: new WorkHistory(),
    version: 0,
    tMs: 0,
    playing: false,
    speed: 1,
    skipIdle: true,
    idleNow: false,
    map: null,
    compare: null,
    selection: null,
  };
}
export function replayOrigin(api: ApiClient): string {
  const address = new URL(api.socketUrl("/"));
  address.protocol = address.protocol === "wss:" ? "https:" : "http:";
  return address.origin;
}
export function readReplayEvents(
  api: ApiClient,
  sessionId: string,
  fromSeq: number,
  signal: AbortSignal,
  onBatch: (events: LocalDotEvent[]) => void,
): Promise<void> {
  return readEventLines(
    api,
    `/api/sessions/${sessionId}/events?fromSeq=${fromSeq}`,
    signal,
    onBatch,
  );
}
// What a conversation shows of a task: its log without the model's thinking or the heartbeats.
export function readTaskHistory(
  api: ApiClient,
  sessionId: string,
  signal: AbortSignal,
  onBatch: (events: LocalDotEvent[]) => void,
): Promise<void> {
  return readEventLines(api, `/api/sessions/${sessionId}/history`, signal, onBatch);
}
async function readEventLines(
  api: ApiClient,
  path: string,
  signal: AbortSignal,
  onBatch: (events: LocalDotEvent[]) => void,
): Promise<void> {
  const response = await api.fetch(`${replayOrigin(api)}${path}`, {
    headers: { authorization: api.authorization(), accept: "application/x-ndjson" },
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  if (response.status === 401) api.rejectUnauthorized?.();
  if (!response.ok) throw new ApiError(response.status, "Session history could not be loaded.");
  if (!response.body) throw new Error("Session history has no response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let batch: LocalDotEvent[] = [];
  const consume = (line: string) => {
    if (!line.trim()) return;
    batch.push(parseEvent(JSON.parse(line)));
    if (batch.length === 1000) {
      onBatch(batch);
      batch = [];
    }
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let start = 0;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        consume(pending.slice(start, newline));
        start = newline + 1;
        newline = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
      if (chunk.done) break;
    }
    if (pending.trim()) consume(pending);
    if (batch.length) onBatch(batch);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function useReplay(
  api: ApiClient,
  sessionId: string | null,
  stage: RefObject<StageHandle | null>,
  // onExit leaves the recording, as Escape does; onGoLive follows a live task back to Watch.
  opts: { onGoLive(): void; onExit?(): void },
): ReplayState {
  const [values, setValues] = useState<ReplayValues>(() => initialState(sessionId));
  const [attempt, setAttempt] = useState(0);
  // Metadata for both tracks is small. Keep it with the task so a screen switch never reloads
  // its event log, clears step details, or resets the playback clock.
  const recordings = useRef(new Map<ScreenName, RecordingInfo>());
  const syncScreen = useRef<() => boolean>(() => false);
  const mediaOwner = useRef(0);
  const current = useRef(values);
  const options = useRef(opts);
  options.current = opts;
  const lastEventMs = useRef(0);
  const pendingSeekTime = useRef<number | null>(null);
  const seekWaiters = useRef(
    new Set<{
      resolve(): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }>(),
  );
  const update = (patch: Partial<ReplayValues>) => {
    current.current = { ...current.current, ...patch };
    setValues(current.current);
  };
  const playbackMap = (state: ReplayValues) => {
    const endMs = state.model.ended?.t ?? lastEventMs.current;
    const activity =
      state.screenChoice === "auto"
        ? [...recordings.current.values()].flatMap((info) => info.manifest.activity)
        : (recordings.current.get(state.screenChoice)?.manifest.activity ?? []);
    return buildPlaybackMap(
      state.model.startT ?? 0,
      endMs,
      busySpans(state.model, activity, endMs),
      state.skipIdle,
    );
  };
  // The page shows a seek as it goes to the worker, so a drag renders Replay once per frame the
  // worker draws, not once per pointer event; the scrubber's head follows the finger on its own.
  const sendSeek = (tMs: number, mode: "exact" | "preview") => {
    const map = current.current.map;
    if (!map) return;
    pendingSeekTime.current = tMs;
    update({ tMs, playing: false, compare: null, idleNow: idleAt(map, tMs) });
    if (!syncScreen.current()) stage.current?.replay.seek(tMs, mode);
  };
  const sending = useRef(sendSeek);
  sending.current = sendSeek;
  const [seeks] = useState(() => new SeekGate((tMs, mode) => sending.current(tMs, mode)));
  const setScreen = (next: ReplayScreen) => {
    if (
      (next !== "auto" && !ScreenName.safeParse(next).success) ||
      next === current.current.screenChoice
    )
      return;
    update({ screenChoice: next, compare: null });
    if (current.current.map) update({ map: playbackMap(current.current) });
    sendTransport();
  };
  const sendTransport = () => {
    if (syncScreen.current()) return;
    const state = current.current;
    if (state.map) {
      pendingSeekTime.current = null;
      seeks.reset();
      stage.current?.replay.transport({
        playing: state.playing,
        speed: state.speed,
        map: state.map,
        atPlayMs: playAt(state.map, state.tMs),
      });
    }
  };
  const seek = (time: number, mode: "exact" | "preview") => {
    const state = current.current;
    if (!state.map || !Number.isFinite(time)) return;
    seeks.seek(Math.min(state.map.endMs, Math.max(state.map.startMs, time)), mode);
  };
  const setSpeed = (speed: ReplaySpeed) => {
    if (!REPLAY_SPEEDS.includes(speed)) return;
    update({ speed });
    sendTransport();
  };
  const setSkipIdle = (skipIdle: boolean) => {
    const state = current.current;
    const map = playbackMap({ ...state, skipIdle });
    update({ skipIdle, map, idleNow: idleAt(map, state.tMs) });
    sendTransport();
  };
  const run = (command: ReplayCommand) => {
    const state = current.current;
    switch (command.kind) {
      case "toggle-play":
        if (!state.map) return;
        update({
          playing: !state.playing,
          compare: null,
          tMs: !state.playing && state.tMs >= state.map.endMs ? state.map.startMs : state.tMs,
        });
        sendTransport();
        break;
      case "pause":
        update({ playing: false });
        sendTransport();
        break;
      case "jump":
        seek(state.tMs + command.ms, "exact");
        break;
      case "step": {
        const positions = chapters(state.model, state.map?.endMs ?? lastEventMs.current).map(
          (chapter) => chapter.startT,
        );
        const target =
          command.dir === 1
            ? positions.find((time) => time > state.tMs + 0.5)
            : positions.findLast((time) => time < state.tMs - 0.5);
        if (target !== undefined) seek(target, "exact");
        break;
      }
      case "speed": {
        const speed =
          REPLAY_SPEEDS[
            Math.max(
              0,
              Math.min(REPLAY_SPEEDS.length - 1, REPLAY_SPEEDS.indexOf(state.speed) + command.dir),
            )
          ];
        if (speed !== undefined) setSpeed(speed);
        break;
      }
      case "compare": {
        const step = stepAt(state.model, state.tMs);
        update({
          playing: false,
          compare: state.compare
            ? null
            : step
              ? compareFrames(state.model, step.id, state.screen)
              : { before: null, after: null },
        });
        sendTransport();
        break;
      }
      case "mark": {
        if (!state.map) return;
        const at = Math.max(state.map.startMs, Math.min(state.map.endMs, state.tMs));
        const from = state.selection?.fromMs ?? state.map.startMs;
        const to = state.selection?.toMs ?? state.map.endMs;
        // A mark past the other end starts the selection over from the recording's edge.
        const selection =
          command.edge === "in"
            ? { fromMs: at, toMs: to > at ? to : state.map.endMs }
            : { fromMs: from < at ? from : state.map.startMs, toMs: at };
        update({ selection: selection.toMs > selection.fromMs ? selection : null });
        break;
      }
      case "exit":
        if (state.compare) update({ compare: null });
        else if (state.selection) update({ selection: null });
        else (options.current.onExit ?? options.current.onGoLive)();
        break;
    }
  };
  const controls = useRef({ seek, setSpeed, setSkipIdle, run });
  controls.current = { seek, setSpeed, setSkipIdle, run };

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt loads the recording again
  useEffect(() => {
    const controller = new AbortController();
    const handle = stage.current;
    let versionTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let sourceKey = "";
    let openedEndMs = 0;
    let lastRefresh = 0;
    const model = emptyModel();
    let agent = emptyAgentModel();
    const work = new WorkHistory();
    const change = (patch: Partial<ReplayValues>) => {
      if (controller.signal.aborted) return;
      current.current = { ...current.current, ...patch };
      setValues(current.current);
    };
    const metadataErrors = new Set<ScreenName>();
    let openedScreen: ScreenName | null = null;
    recordings.current = new Map();
    mediaOwner.current++;
    change({ ...initialState(sessionId), model, work });
    lastEventMs.current = 0;
    pendingSeekTime.current = null;
    seeks.reset();
    handle?.resetSession();
    function notifyModel() {
      if (versionTimer !== undefined) return;
      versionTimer = setTimeout(() => {
        versionTimer = undefined;
        change({ agent, version: current.current.version + 1 });
      }, 100);
    }
    const selectedScreen = () => {
      const state = current.current;
      return state.screenChoice === "auto"
        ? (screenAt(model, state.tMs)?.screen ?? "desktop")
        : state.screenChoice;
    };
    // Return true when the new source owns transport. Commands to the retired worker must not
    // race it or overwrite the new playhead; the owner also rejects late frames/status messages.
    function presentScreen(refresh = false): boolean {
      if (!sessionId || !current.current.map || controller.signal.aborted) return false;
      const screen = selectedScreen();
      const info = recordings.current.get(screen);
      if (!info) {
        if (screen !== current.current.screen || metadataErrors.has(screen)) {
          mediaOwner.current++;
          if (openedScreen) handle?.replay.close();
          openedScreen = null;
          sourceKey = "";
          change({ screen, info: null, status: metadataErrors.has(screen) ? "error" : "loading" });
        }
        return true;
      }
      const state = current.current;
      const changed = openedScreen !== screen;
      if (!changed && !refresh) return false;
      const map = playbackMap(state);
      change({ screen, info, map, idleNow: idleAt(map, state.tMs) });
      const hasVideo =
        info.servedBytes > 0 && !["none", "failed", "expired"].includes(info.manifest.state);
      const source: ReplaySource = {
        screen,
        ...(info.manifest.width && info.manifest.height
          ? { geometry: { w: info.manifest.width, h: info.manifest.height, scale: 1 } }
          : {}),
        sessionId,
        origin: replayOrigin(api),
        authorization: api.authorization(),
        video: hasVideo ? recordingSnapshot(info) : null,
        gaps: info.manifest.gaps,
      };
      const key = JSON.stringify([
        screen,
        source.geometry,
        source.video,
        source.gaps,
        info.manifest.state,
      ]);
      const reopen = changed || key !== sourceKey;
      if (reopen) {
        sourceKey = key;
        openedScreen = screen;
        source.owner = ++mediaOwner.current;
        seeks.reset();
        if (state.playing) pendingSeekTime.current = null;
        change({
          status: hasVideo ? "loading" : "no-video",
          ...(changed ? { compare: null } : {}),
        });
        handle?.replay.open(source);
      }
      if (reopen || map.endMs !== openedEndMs) {
        openedEndMs = map.endMs;
        handle?.replay.transport({
          playing: state.playing,
          speed: state.speed,
          map,
          atPlayMs: playAt(map, state.tMs),
        });
      }
      return reopen;
    }
    syncScreen.current = presentScreen;
    async function load(initial: boolean) {
      if (loading || !sessionId || !ULID_PATTERN.test(sessionId)) {
        if (initial) change({ status: "error" });
        return;
      }
      loading = true;
      try {
        const card = SessionCard.parse(
          await api.get(`/api/sessions/${sessionId}/card`, { signal: controller.signal }),
        );
        await readReplayEvents(api, sessionId, model.lastSeq + 1, controller.signal, (events) => {
          if (controller.signal.aborted) return;
          foldEvents(model, events);
          for (const event of events) {
            agent = projectAgentEvent(agent, event);
            work.add(event, agent);
          }
          lastEventMs.current = Math.max(
            lastEventMs.current,
            sessionMsOf(events.at(-1) as LocalDotEvent),
          );
          handle?.pushEvents(events);
          notifyModel();
        });
        // A missing/failed alternate track must not prevent the available screen from playing.
        const screens = ["desktop", "browser"] as const;
        const metadata = await Promise.allSettled(
          screens.map(async (screen) =>
            RecordingInfo.parse(
              await api.get(
                `/api/sessions/${sessionId}/recording${screen === "browser" ? "?screen=browser" : ""}`,
                { signal: controller.signal },
              ),
            ),
          ),
        );
        controller.signal.throwIfAborted();
        metadata.forEach((result, index) => {
          const screen = screens[index] as ScreenName;
          if (result.status === "fulfilled") {
            recordings.current.set(screen, result.value);
            metadataErrors.delete(screen);
          } else metadataErrors.add(screen);
        });
        const state = current.current;
        const map = playbackMap(state);
        const requested = Number(new URLSearchParams(window.location.search).get("t") ?? 0);
        const tMs = Math.min(
          map.endMs,
          Math.max(map.startMs, initial && Number.isFinite(requested) ? requested : state.tMs),
        );
        change({ agent, card, map, tMs, idleNow: idleAt(map, tMs) });
        const info = recordings.current.get(selectedScreen());
        const liveNowMs = Math.max(map.endMs, Date.now() - Date.parse(card.startedAt));
        const follow = initial
          ? "stay"
          : followRule({
              live: info?.live ?? card.verdict === "live",
              playing: state.playing,
              tMs,
              lastMs: openedEndMs,
              liveNowMs,
            });
        if (follow === "go-live") {
          options.current.onGoLive();
          return;
        }
        presentScreen(initial || follow === "refresh" || !state.playing || !info?.live);
        lastRefresh = performance.now();
      } catch {
        if (!controller.signal.aborted) change({ status: "error" });
      } finally {
        loading = false;
        if (
          !controller.signal.aborted &&
          (current.current.info?.live || current.current.card?.verdict === "live")
        ) {
          clearTimeout(pollTimer);
          pollTimer = setTimeout(() => {
            void load(false);
          }, 2000);
        }
      }
    }
    const unsubscribe = handle?.replay.onReplay((message) => {
      if (controller.signal.aborted) return;
      if (
        (message.type === "replay-status" ||
          message.type === "replay-time" ||
          message.type === "replay-ended") &&
        message.owner !== mediaOwner.current
      )
        return;
      if (message.type === "replay-status" || message.type === "replay-time") seeks.settled();
      if ("owner" in message && message.owner !== mediaOwner.current) return;
      if (message.type === "replay-status") change({ status: message.status.state });
      // A finished video compacted while it was open: read its new size and open that.
      if (
        message.type === "replay-status" &&
        message.status.state === "error" &&
        !current.current.info?.live
      )
        void load(false);
      if (message.type === "replay-time") {
        if (
          pendingSeekTime.current !== null &&
          Math.abs(message.tMs - pendingSeekTime.current) > 0.1
        )
          return;
        pendingSeekTime.current = null;
        const state = current.current;
        change({ tMs: message.tMs, playing: message.playing, idleNow: message.idle });
        if (presentScreen()) return;
        for (const waiter of seekWaiters.current) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
        seekWaiters.current.clear();
        if (
          (state.info?.live || state.card?.verdict === "live") &&
          state.playing &&
          message.tMs >= openedEndMs - 250 &&
          performance.now() - lastRefresh >= 500
        )
          void load(false);
      }
      if (message.type === "replay-ended") {
        if (current.current.info?.live || current.current.card?.verdict === "live") {
          change({ playing: true });
          void load(false);
        } else change({ playing: false });
      }
    });
    void load(true);
    if (new URLSearchParams(window.location.search).get("replayProbe") === "1") {
      window.__localdot ??= {};
      window.__localdot.replay = {
        status: () => current.current.status,
        seek: (time, mode) =>
          new Promise<void>((resolve, reject) => {
            const waiter = {
              resolve,
              reject,
              timer: setTimeout(() => {
                seekWaiters.current.delete(waiter);
                reject(new Error("Replay seek timed out"));
              }, 10_000),
            };
            seekWaiters.current.add(waiter);
            controls.current.seek(time, mode);
          }),
        transport: (patch) => {
          if (patch.speed !== undefined) controls.current.setSpeed(patch.speed);
          if (patch.skipIdle !== undefined) controls.current.setSkipIdle(patch.skipIdle);
          if (patch.playing !== undefined && patch.playing !== current.current.playing)
            controls.current.run({ kind: "toggle-play" });
        },
        probe: (command) =>
          handle?.replay.probe(command) ?? Promise.reject(new Error("Replay worker unavailable")),
      };
    }
    return () => {
      controller.abort();
      syncScreen.current = () => false;
      clearTimeout(versionTimer);
      clearTimeout(pollTimer);
      unsubscribe?.();
      handle?.replay.close();
      for (const waiter of seekWaiters.current) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Replay closed"));
      }
      seekWaiters.current.clear();
      if (window.__localdot) delete window.__localdot.replay;
    };
  }, [api, sessionId, stage, seeks, attempt]);
  return {
    // Until the effect resets for a newly picked session, the held values describe the previous one.
    ...(values.sessionId === sessionId ? values : initialState(sessionId)),
    setScreen,
    run,
    seek,
    setSpeed,
    setSkipIdle,
    retry: () => setAttempt((count) => count + 1),
    selectStep: (stepId) => {
      const index = current.current.model.stepIndex.get(stepId);
      const step = index === undefined ? undefined : current.current.model.steps[index];
      if (step) seek(step.startT, "exact");
    },
  };
}
