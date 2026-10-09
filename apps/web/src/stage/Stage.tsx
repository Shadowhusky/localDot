import type { LocalDotEvent, ManualStreamInput, ScreenSelectionSnapshot } from "@localdot/protocol";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import type { ProbeApi } from "./debug-hooks.ts";
import { frameTapSupport } from "./frame-source.ts";
import {
  findStream,
  holdStream,
  KEEP_MS,
  type LiveStream,
  type StreamPicture,
} from "./live-stream.ts";
import { ManualSurface, type ManualSurfaceHandle, type PointerMode } from "./ManualSurface.tsx";
import type { Flip } from "./probe.ts";
import { StageCanvas } from "./StageCanvas.tsx";
import type { ReplayHandle, StageCanvasHandle } from "./stage-engine.ts";
import type { OracleRequest, StageClock, StageViewPatch } from "./worker-protocol.ts";

export interface StageHandle {
  replay: ReplayHandle;
  pushEvents(events: LocalDotEvent[]): void;
  resetSession(): void;
  setClock(clock: StageClock): void;
  setView(view: StageViewPatch): void;
  oracle(command: OracleRequest): Promise<unknown>;
  // Raises or lowers the keyboard that types on the computer while the user has control.
  keyboard(on: boolean): void;
}

export interface StageProps {
  mode?: "live" | "replay";
  cell: CellSummary | null;
  parentId?: string;
  selection?: ScreenSelectionSnapshot;
  api: ApiClient;
  reconnects: number;
  listed: readonly string[];
  manual?: {
    enabled: boolean;
    screen: { w: number; h: number };
    pointer: PointerMode;
    send(input: ManualStreamInput): void;
    onTyping?(typing: boolean): void;
    onRefused?(message: string | null): void;
  };
  // What the live stage shows of its computer: nothing yet, its picture, or its last picture while
  // the stream reconnects.
  onPicture?(picture: StreamPicture): void;
}

const quiet = () => () => {};

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  { cell, api, reconnects, listed, manual, mode = "live", parentId, selection, onPicture },
  ref,
) {
  const support =
    mode === "live"
      ? frameTapSupport()
      : typeof VideoFrame !== "undefined" && typeof OffscreenCanvas !== "undefined"
        ? { ok: true }
        : {
            ok: false,
            reason: "This browser lacks WebCodecs. Open localDot in a current Chromium browser.",
          };
  const canvas = useRef<StageCanvasHandle>(null);
  const keyboard = useRef<ManualSurfaceHandle>(null);
  // The live stage's engine outlives a remount, so moving the stage keeps its picture.
  const [keep] = useState(() => (mode === "live" ? api : undefined));
  const cellId = cell?.id ?? null;
  const surface = selection?.screen ?? "desktop";
  const ready =
    mode === "live" &&
    cell?.state === "ready" &&
    !cell.paused &&
    !cell.fenced &&
    !cell.replacementPending &&
    (!selection || selection.cellId === cellId) &&
    (surface !== "browser" || (!!parentId && parentId !== cellId));
  // What the stage shows. A new revision of the same screen, a status socket that reopens or a
  // refreshed ticket is not a new owner: each used to reload the client and blank the picture.
  const owner = useMemo(
    () => ({ api, cellId, ready, mode, surface, parentId }),
    [api, cellId, ready, mode, surface, parentId],
  );
  const currentOwner = useRef(owner);
  const sourceOwner = useRef<typeof owner | null>(null);
  const [displayOwner, setDisplayOwner] = useState<typeof owner | null>(null);
  const [held, setHeld] = useState<{ owner: typeof owner; stream: LiveStream } | null>(null);
  const stream =
    held?.owner === owner
      ? held.stream
      : ready && cellId && support.ok
        ? (findStream({ api, cellId, surface, parentId }) ?? null)
        : null;
  const streamRef = useRef(stream);
  streamRef.current = stream;
  useLayoutEffect(() => {
    const leavingReplay = currentOwner.current.mode === "replay" && owner.mode === "live";
    currentOwner.current = owner;
    sourceOwner.current = null;
    setDisplayOwner(null);
    if (leavingReplay) canvas.current?.replay.close();
    canvas.current?.detach();
  }, [owner]);
  const flips = useRef<Flip[]>([]);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const listedRef = useRef(listed);
  useEffect(() => {
    listedRef.current = listed;
  }, [listed]);

  useEffect(() => {
    if (!cellId || !ready || !support.ok) return;
    const { stream, release } = holdStream(
      { api, cellId, surface, parentId },
      () => listedRef.current,
    );
    setHeld({ owner, stream });
    const disconnect = stream.connect((source) => {
      if (currentOwner.current !== owner || !canvas.current) {
        source.stop();
        return;
      }
      sourceOwner.current = owner;
      canvas.current.attach(source);
    });
    return () => {
      disconnect();
      const next = currentOwner.current;
      // A computer that stopped or froze takes its stream with it; any other stage may come back.
      const stopped =
        next !== owner &&
        next.mode === "live" &&
        next.api === api &&
        next.cellId === cellId &&
        next.surface === surface &&
        !next.ready;
      release(stopped ? 0 : KEEP_MS);
    };
  }, [api, cellId, ready, support.ok, owner, parentId, surface]);

  // A status socket that reopened may follow a daemon restart, which ends its tickets.
  const seenReconnects = useRef(reconnects);
  useEffect(() => {
    if (reconnects === seenReconnects.current) return;
    seenReconnects.current = reconnects;
    stream?.renew();
  }, [reconnects, stream]);

  const picture = useSyncExternalStore(stream?.subscribe ?? quiet, () => stream?.picture ?? "none");
  const shown: StreamPicture = mode === "live" ? picture : "none";
  useEffect(() => {
    onPicture?.(shown);
  }, [shown, onPicture]);

  // Overlays freeze while the stream is not live (spec, error handling); zoom comes from ?zoom= for tests.
  const reconnecting =
    mode === "live" &&
    !cell?.paused &&
    (cell?.stream.connection === "stalled" ||
      cell?.stream.connection === "disconnected" ||
      shown === "held");
  const paused = mode === "live" && (!!cell?.paused || reconnecting);
  const manualActive = Boolean(manual);
  useEffect(() => {
    canvas.current?.setView({ selection: mode === "live" ? (selection ?? null) : null });
  }, [mode, selection]);
  useEffect(() => {
    canvas.current?.setView({
      freeze: paused,
      zoom: manualActive ? 1 : Number(params.get("zoom") ?? 1) || 1,
    });
  }, [paused, params, manualActive]);

  const onStats = useCallback(() => {
    if (sourceOwner.current !== currentOwner.current) return;
    streamRef.current?.presented();
    setDisplayOwner(currentOwner.current);
  }, []);
  useEffect(() => {
    if (!stream) return;
    // A view update also restarts the worker's animation after a suspension.
    const resume = () => {
      canvas.current?.setView({ freeze: paused });
      stream.replace();
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      canvas.current?.setView({ freeze: paused });
      stream.refresh();
    };
    document.addEventListener("resume", resume);
    document.addEventListener("visibilitychange", visible);
    return () => {
      document.removeEventListener("resume", resume);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [stream, paused]);
  const onFlip = useCallback((flip: Flip) => {
    flips.current.push(flip);
  }, []);

  useEffect(() => {
    if (params.get("probe") !== "1") return;
    const probe: ProbeApi = {
      start: (rect, threshold = 128) => canvas.current?.probe(rect, threshold),
      stop: () => canvas.current?.probe(null),
      flips: () => flips.current,
      clear: () => {
        flips.current = [];
      },
    };
    window.__localdot = { ...window.__localdot, probe };
    return () => {
      if (window.__localdot) window.__localdot.probe = undefined;
    };
  }, [params]);

  useEffect(() => {
    if (params.get("oracle") !== "1") return;
    const request = (command: OracleRequest) =>
      canvas.current?.oracle(command) ?? Promise.reject(new Error("stage not ready"));
    window.__localdot = {
      ...window.__localdot,
      oracle: {
        enable: (zooms: number[]) => request({ op: "enable", zooms }),
        dump: () => request({ op: "dump" }),
        template: () => request({ op: "template" }),
        renderTwice: (tMs: number) => request({ op: "render-twice", tMs }),
      },
    };
    return () => {
      if (window.__localdot) window.__localdot.oracle = undefined;
    };
  }, [params]);

  useImperativeHandle(ref, () => ({
    replay: {
      open: (source) => canvas.current?.replay.open(source),
      transport: (transport) => canvas.current?.replay.transport(transport),
      seek: (tMs, seekMode) => canvas.current?.replay.seek(tMs, seekMode),
      close: () => canvas.current?.replay.close(),
      onReplay: (listener) => canvas.current?.replay.onReplay(listener) ?? (() => {}),
      probe: (command) =>
        canvas.current?.replay.probe(command) ?? Promise.reject(new Error("stage not ready")),
    },
    pushEvents: (events) => canvas.current?.pushEvents(events),
    resetSession: () => canvas.current?.resetSession(),
    setClock: (clock) => canvas.current?.setClock(clock),
    setView: (view) => canvas.current?.setView(manual ? { ...view, zoom: 1 } : view),
    oracle: (command) => canvas.current?.oracle(command) ?? Promise.resolve(undefined),
    keyboard: (on) => keyboard.current?.keyboard(on),
  }));

  if (!support.ok) {
    return (
      <div className="stage-veil" role="alert">
        <p>{support.reason}</p>
      </div>
    );
  }
  return (
    <>
      <StageCanvas ref={canvas} keep={keep} onFlip={onFlip} onStats={onStats} />
      {mode === "live" && manual && (
        <ManualSurface
          ref={keyboard}
          live={manual.enabled && ready && !reconnecting && !!stream && displayOwner === owner}
          mode={manual.pointer}
          locate={(point, follow) =>
            canvas.current?.manualPoint(point, manual.screen, follow) ?? null
          }
          send={manual.send}
          onTyping={manual.onTyping}
          onRefused={manual.onRefused}
        />
      )}
    </>
  );
});
