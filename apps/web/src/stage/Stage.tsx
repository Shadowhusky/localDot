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
import { onForeground } from "../lib/foreground.ts";
import type { ScreenName, StageConnection } from "./connection.ts";
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
import type { PumpStats } from "./pump.ts";
import { StageCanvas } from "./StageCanvas.tsx";
import { StageNotice } from "./StageNotice.tsx";
import type { ReplayHandle, StageCanvasHandle, StageView } from "./stage-engine.ts";
import { stageFramerate } from "./stream-quality.ts";
import type { FieldMark, OracleRequest, StageClock, StageViewPatch } from "./worker-protocol.ts";

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
  // A decision is open: the picture dims under it.
  dim?: boolean;
  // The fields dot will type the user's answers into, ringed above the dim.
  fields?: readonly FieldMark[];
  manual?: {
    enabled: boolean;
    screen: { w: number; h: number };
    pointer: PointerMode;
    send(input: ManualStreamInput): void;
    onTyping?(typing: boolean): void;
    onRefused?(message: string | null): void;
  };
  // This viewer's picture of the screen it shows, including deliberate background suspension
  // versus a lost stream.
  onPicture?(picture: StreamPicture, screen: ScreenName): void;
  // How the picture has fared in this view (useStageConnection): it is held, dimmed, while away.
  connection?: StageConnection;
  // Something the page shows covers the whole stage, or folds it away: its stream pauses, as it
  // does by itself once the stage leaves the viewport.
  covered?: boolean;
}

const quiet = () => () => {};
const NO_FIELDS: readonly FieldMark[] = [];

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  {
    cell,
    api,
    reconnects,
    listed,
    manual,
    mode = "live",
    parentId,
    selection,
    dim = false,
    fields = NO_FIELDS,
    onPicture,
    connection,
    covered = false,
  },
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
  // Live once the stage has presented this screen's own frames, not merely its stream's.
  const shown: StreamPicture =
    mode !== "live" ? "none" : picture === "live" && displayOwner !== owner ? "none" : picture;
  useEffect(() => {
    onPicture?.(shown, surface);
  }, [shown, surface, onPicture]);

  // Overlays freeze while the stream is not live (spec, error handling); zoom comes from ?zoom= for tests.
  const away = mode === "live" && connection?.phase === "away" && connection.level !== "blip";
  const reconnecting =
    mode === "live" &&
    !cell?.paused &&
    (cell?.stream.connection === "stalled" ||
      cell?.stream.connection === "disconnected" ||
      shown === "held" ||
      away);
  const paused = mode === "live" && (!!cell?.paused || reconnecting || shown === "suspended");
  const manualActive = Boolean(manual);
  useEffect(() => {
    canvas.current?.setView({ selection: mode === "live" ? (selection ?? null) : null });
  }, [mode, selection]);
  useEffect(() => {
    canvas.current?.setView({ dim });
  }, [dim]);
  useEffect(() => {
    canvas.current?.setView({ fields: mode === "live" ? fields : NO_FIELDS });
  }, [mode, fields]);
  useEffect(() => {
    canvas.current?.setView({
      freeze: paused,
      zoom: manualActive ? 1 : Number(params.get("zoom") ?? 1) || 1,
    });
  }, [paused, params, manualActive]);

  const onStats = useCallback((stats: PumpStats) => {
    if (sourceOwner.current !== currentOwner.current) return;
    streamRef.current?.presented(stats.presented);
    setDisplayOwner(currentOwner.current);
  }, []);
  useEffect(() => {
    if (!stream) return;
    // Wake the renderer as well as its source; a browser may have suspended either one.
    return onForeground((reason) => {
      // A window focus event alone does not mean capture was suspended.
      if (reason === "focus" && stream.picture === "live") return false;
      canvas.current?.setView({ freeze: paused });
      if (reason === "resume") stream.replace();
      else stream.refresh();
    });
  }, [stream, paused]);
  const onFlip = useCallback((flip: Flip) => {
    flips.current.push(flip);
  }, []);

  // A small stage asks for fewer frames than a large one or the user's own control, and one out of
  // sight asks for none and draws nothing.
  const [view, setStageView] = useState<StageView>({ onScreen: true, share: 0 });
  const control = !!manual?.enabled;
  const framerate = useMemo(
    () => stageFramerate({ share: view.share, control }),
    [view.share, control],
  );
  const inSight = view.onScreen && !covered;
  useEffect(() => {
    canvas.current?.setView({ fps: framerate });
  }, [framerate]);
  useEffect(() => {
    stream?.cap(framerate);
  }, [stream, framerate]);
  useEffect(() => {
    canvas.current?.setView({ hidden: !inSight });
  }, [inSight]);
  useEffect(() => {
    stream?.show(inSight);
  }, [stream, inSight]);

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
      <StageCanvas
        ref={canvas}
        keep={keep}
        onFlip={onFlip}
        onStats={onStats}
        onView={setStageView}
      />
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
      {mode === "live" && connection && (
        <StageNotice connection={connection} onRetry={stream ? () => stream.retry() : undefined} />
      )}
    </>
  );
});
