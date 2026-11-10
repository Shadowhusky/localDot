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
import type { BrowserEngineName } from "../../../../packages/protocol/src/browser-engine.ts";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { onForeground } from "../lib/foreground.ts";
import { BrowserWindow, sayApart } from "./BrowserWindow.tsx";
import type { StagePoint } from "./composite.ts";
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
import { isApple, switchesWindow } from "./manual-keys.ts";
import type { Flip } from "./probe.ts";
import type { PumpStats } from "./pump.ts";
import { StageCanvas } from "./StageCanvas.tsx";
import { StageNotice } from "./StageNotice.tsx";
import type { ReplayHandle, StageCanvasHandle, StageView } from "./stage-engine.ts";
import { stageFramerate } from "./stream-quality.ts";
import { useDockCovered } from "./useDockCovered.ts";
import type { StageFront } from "./useStageFront.ts";
import { useUnderDesktop } from "./useUnderDesktop.ts";
import type {
  FieldMark,
  OracleRequest,
  StageClock,
  StageComposite,
  StageViewPatch,
} from "./worker-protocol.ts";

export interface StageHandle {
  replay: ReplayHandle;
  pushEvents(events: LocalDotEvent[]): void;
  resetSession(): void;
  setClock(clock: StageClock): void;
  setView(view: StageViewPatch): void;
  oracle(command: OracleRequest): Promise<unknown>;
  // Raises or lowers the keyboard that types on the computer while the user has control.
  keyboard(on: boolean): void;
  // The viewer asked for the screen to try again.
  retryStream(): void;
}

export interface StageProps {
  mode?: "live" | "replay";
  // The computer whose screen is in front.
  cell: CellSummary | null;
  parentId?: string;
  // The task on show, whose own web browser a conversation may have.
  session?: string;
  // The desktop, which the web browser is a window on: both make the one screen.
  parent?: CellSummary | null;
  // Which of them is in front, from useStageFront; else the one dot is on (`selection`).
  front?: StageFront;
  // What the web browser runs, which its window and dock item are named and drawn for.
  browserEngine?: BrowserEngineName;
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
const SWITCH_KEYS = isApple() ? "Option-Tab" : "Alt+Tab";

// Where the keys typed go, and the keys that bring the other window forward.
export function keysTo(front: "desktop" | "browser"): string {
  return front === "browser"
    ? `Keys go to the web browser's window. ${SWITCH_KEYS} brings the desktop forward.`
    : `Keys go to the desktop. ${SWITCH_KEYS} brings the web browser forward.`;
}

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  {
    cell,
    api,
    reconnects,
    listed,
    manual,
    mode = "live",
    parentId,
    session,
    parent,
    front,
    browserEngine,
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
  const surface = front?.screen ?? selection?.screen ?? "desktop";
  const ready =
    mode === "live" &&
    cell?.state === "ready" &&
    !cell.paused &&
    !cell.fenced &&
    !cell.replacementPending &&
    (!selection || selection.screen !== surface || selection.cellId === cellId) &&
    (surface !== "browser" || (!!parentId && parentId !== cellId));
  const parentScale = parent?.scale;
  const composite = useMemo<StageComposite | null>(
    () =>
      mode === "live" && parentScale
        ? { front: surface, desktop: { w: 1280 * parentScale, h: 800 * parentScale } }
        : null,
    [mode, parentScale, surface],
  );
  const desktopUp =
    parent?.state === "ready" && !parent.paused && !parent.fenced && !parent.replacementPending;
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
  // Before any frame of the screen coming forward: the pictures change places first.
  useLayoutEffect(() => {
    canvas.current?.setView({ composite });
  }, [composite]);
  const flips = useRef<Flip[]>([]);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const listedRef = useRef(listed);
  useEffect(() => {
    listedRef.current = listed;
  }, [listed]);
  // A press that went past the edge of its screen: it stopped there, and nothing crossed.
  const pastEdge = useRef(false);
  // The user's input, sent to the screen under their pointer. A press on the one behind brings it
  // forward once it lets go, so the press itself never goes astray while the screens change places;
  // one on the desktop beside the window only brings it forward.
  const route = useCallback(
    (input: ManualStreamInput) => {
      const at = "at" in input ? (input.at as Partial<StagePoint>) : null;
      const screen = at?.screen;
      if (!at || !screen) {
        manual?.send(input);
        return;
      }
      const { screen: _, behind, ...point } = at;
      if (!behind) manual?.send({ ...input, at: point, screen } as ManualStreamInput);
      if (input.kind === "up" && pastEdge.current) {
        pastEdge.current = false;
        sayApart();
      }
      if (screen !== surface && (input.kind === "up" || input.kind === "click"))
        front?.pick(screen);
    },
    [manual, surface, front],
  );

  useEffect(() => {
    if (!cellId || !ready || !support.ok) return;
    const { stream, release } = holdStream(
      { api, cellId, surface, parentId, ...(session ? { session } : {}) },
      () => listedRef.current,
    );
    setHeld({ owner, stream });
    const disconnect = stream.connect(
      (source) => {
        if (currentOwner.current !== owner || !canvas.current) {
          source.stop();
          return;
        }
        sourceOwner.current = owner;
        canvas.current.attach(source);
      },
      (now) => canvas.current?.restart({ now }),
    );
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
  }, [api, cellId, ready, support.ok, owner, parentId, surface, session]);

  useEffect(() => canvas.current?.onRestart(() => streamRef.current?.retap()), []);

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
      // A window focus event alone does not mean capture was suspended, nor is one still connecting
      // any the worse for it.
      if (reason === "focus" && (stream.picture === "live" || stream.picture === "none"))
        return false;
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
  useUnderDesktop({
    api,
    canvas,
    listed: listedRef,
    cellId: composite?.front === "browser" && desktopUp && support.ok ? (parent?.id ?? null) : null,
    inSight,
    live: control,
  });
  // Whether a window on the desktop covers its dock, asked only while the dock item could show.
  const dockCovered = useDockCovered(
    api,
    mode === "live" && composite?.front === "desktop" && front && desktopUp && inSight
      ? (parent?.id ?? null)
      : null,
  );

  // While the user holds the computer, the app switcher's keys bring the other window forward, from
  // the keyboard field or a page with nothing else focused, and reach neither screen.
  const switching = mode === "live" && composite && manualActive ? front : undefined;
  useEffect(() => {
    if (!switching) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !switchesWindow(event)) return;
      const at = event.target;
      if (at instanceof HTMLElement && at !== document.body && !at.closest(".manual-keyboard"))
        return;
      event.preventDefault();
      if (!event.repeat) switching.pick(surface === "browser" ? "desktop" : "browser");
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [switching, surface]);

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
    retryStream: () => streamRef.current?.retry(),
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
          locate={(point, within) => {
            const stage = canvas.current;
            if (!composite) return stage?.manualPoint(point, manual.screen, !!within) ?? null;
            const pressed = within as StagePoint | null | undefined;
            if (
              pressed &&
              !pressed.behind &&
              surface === "browser" &&
              stage?.stagePoint(point, composite.desktop, surface)?.screen !== pressed.screen
            )
              pastEdge.current = true;
            return stage?.stagePoint(point, composite.desktop, surface, pressed) ?? null;
          }}
          send={route}
          keysTo={composite ? keysTo(surface) : undefined}
          onTyping={manual.onTyping}
          onRefused={manual.onRefused}
        />
      )}
      {mode === "live" && composite && desktopUp && (
        <BrowserWindow
          screen={surface}
          drawn={displayOwner === owner}
          front={front}
          holding={manualActive}
          engine={browserEngine}
          covered={dockCovered}
        />
      )}
      {mode === "live" && connection && (
        <StageNotice connection={connection} onRetry={stream ? () => stream.retry() : undefined} />
      )}
    </>
  );
});
