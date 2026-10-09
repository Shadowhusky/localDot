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
} from "react";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { Spinner } from "../ui/Spinner.tsx";
import { forgetOldTickets } from "./client-storage.ts";
import { DesktopFrame } from "./DesktopFrame.tsx";
import type { ProbeApi } from "./debug-hooks.ts";
import { type FrameSource, frameTapSupport } from "./frame-source.ts";
import { ManualSurface, type ManualSurfaceHandle, type PointerMode } from "./ManualSurface.tsx";
import type { Flip } from "./probe.ts";
import { type ReplayHandle, StageCanvas, type StageCanvasHandle } from "./StageCanvas.tsx";
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
}

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
  const presentedAt = useRef(0);
  const [generation, setGeneration] = useState(0);
  const cellId = cell?.id ?? null;
  const surface = selection?.screen ?? "desktop";
  const revision = selection?.revision ?? 0;
  const ready =
    mode === "live" &&
    cell?.state === "ready" &&
    !cell.paused &&
    !cell.fenced &&
    !cell.replacementPending &&
    (!selection || selection.cellId === cellId) &&
    (surface !== "browser" || (!!parentId && parentId !== cellId));
  const owner = useMemo(
    () => ({ api, cellId, ready, generation, reconnects, mode, surface, revision, parentId }),
    [api, cellId, ready, generation, reconnects, mode, surface, revision, parentId],
  );
  const currentOwner = useRef(owner);
  const sourceOwner = useRef<typeof owner | null>(null);
  const [ticket, setTicket] = useState<{ owner: typeof owner; src: string } | null>(null);
  const [displayOwner, setDisplayOwner] = useState<typeof owner | null>(null);
  const src = mode === "live" && ticket?.owner === owner ? ticket.src : null;
  useLayoutEffect(() => {
    const leavingReplay = currentOwner.current.mode === "replay" && owner.mode === "live";
    currentOwner.current = owner;
    sourceOwner.current = null;
    presentedAt.current = 0;
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

  // A self-reloading client reuses its ticket, which dies with the daemon: a new generation mints a
  // new ticket and remounts the iframe (S8).
  useEffect(() => {
    if (!cellId || !ready || !support.ok) {
      setTicket(null);
      return;
    }
    let cancelled = false;
    api
      .post<{ path: string; cellId?: string }>(
        `/api/cells/${surface === "browser" ? parentId : cellId}/${surface === "browser" ? "browser-stream-ticket" : "stream-ticket"}?g=${generation}.${reconnects}`,
      )
      .then(
        ({ path, cellId: physicalId }) => {
          if (
            !cancelled &&
            typeof path === "string" &&
            path.startsWith(`/cells/${cellId}/${surface}/`) &&
            (surface !== "browser" || physicalId === cellId) &&
            /^\/cells\/[^/]+\/(?:desktop|browser)\/[A-Za-z0-9_-]{22}\/$/.test(path)
          ) {
            forgetOldTickets({ cellId, livePath: path, listed: listedRef.current });
            setTicket({ owner, src: `${path}#shared` });
          }
        },
        () => {},
      );
    return () => {
      cancelled = true;
    };
  }, [api, cellId, ready, support.ok, generation, reconnects, owner, parentId, surface]);

  // Overlays freeze while the stream is not live (spec, error handling); zoom comes from ?zoom= for tests.
  const reconnecting =
    mode === "live" &&
    !cell?.paused &&
    (cell?.stream.connection === "stalled" || cell?.stream.connection === "disconnected");
  const paused = mode === "live" && (!!cell?.paused || reconnecting);
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

  const onSource = useCallback(
    (source: FrameSource) => {
      if (currentOwner.current !== owner || ticket?.owner !== owner || !canvas.current) {
        source.stop();
        return;
      }
      sourceOwner.current = owner;
      setDisplayOwner(null);
      presentedAt.current = 0;
      canvas.current.attach(source);
    },
    [owner, ticket],
  );
  const onLost = useCallback(() => {
    if (currentOwner.current === owner) setGeneration((g) => g + 1);
  }, [owner]);
  const lastPresentedAt = useCallback(() => presentedAt.current, []);
  const onStats = useCallback(() => {
    if (sourceOwner.current !== currentOwner.current) return;
    presentedAt.current = Date.now();
    setDisplayOwner(currentOwner.current);
  }, []);
  useEffect(() => {
    if (!ready) return;
    // A browser-frozen tab can accumulate obsolete decoder messages. Resume with a fresh
    // stream instead of making the viewer drain that backlog before seeing the current desktop.
    const resume = () => {
      canvas.current?.setView({ freeze: paused });
      onLost();
    };
    const visible = () => {
      if (document.visibilityState === "visible") resume();
    };
    document.addEventListener("resume", resume);
    document.addEventListener("visibilitychange", visible);
    return () => {
      document.removeEventListener("resume", resume);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [ready, paused, onLost]);
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
      <StageCanvas ref={canvas} onFlip={onFlip} onStats={onStats} />
      {src && (
        <DesktopFrame
          key={`${src} ${generation}.${reconnects}`}
          src={src}
          onSource={onSource}
          onStale={onLost}
          lastPresentedAt={lastPresentedAt}
        />
      )}
      <div className={reconnecting ? "stage-veil on" : "stage-veil"} aria-hidden={!reconnecting}>
        <p className="stage-chip">
          <Spinner size={14} />
          Reconnecting…
        </p>
      </div>
      {mode === "live" && manual && (
        <ManualSurface
          ref={keyboard}
          live={manual.enabled && ready && !reconnecting && !!src && displayOwner === owner}
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
