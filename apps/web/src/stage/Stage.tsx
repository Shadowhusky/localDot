import type { LocalDotEvent, ManualInput } from "@localdot/protocol";
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
import { forgetOldTickets } from "./client-storage.ts";
import { DesktopFrame } from "./DesktopFrame.tsx";
import { type FrameSource, frameTapSupport } from "./frame-source.ts";
import { manualKey } from "./manual-point.ts";
import type { Flip, ProbeRect } from "./probe.ts";
import { StageCanvas, type StageCanvasHandle } from "./StageCanvas.tsx";
import type { OracleRequest, StageClock, StageViewPatch } from "./worker-protocol.ts";

export interface ProbeApi {
  start(rect: ProbeRect, threshold?: number): void;
  stop(): void;
  flips(): Flip[];
  clear(): void;
}

export interface StageHandle {
  pushEvents(events: LocalDotEvent[]): void;
  resetSession(): void;
  setClock(clock: StageClock): void;
  setView(view: StageViewPatch): void;
  oracle(command: OracleRequest): Promise<unknown>;
}

export interface StageProps {
  cell: CellSummary | null;
  api: ApiClient;
  // The agent has control: the stage wears the xenon rim.
  control?: boolean;
  reconnects: number;
  listed: readonly string[];
  manual?: {
    requestId: string;
    enabled: boolean;
    screen: { w: number; h: number };
    button: "left" | "right";
    count: 1 | 2;
    input(requestId: string, input: ManualInput): Promise<boolean>;
  };
}

declare global {
  interface Window {
    __localdot?: { probe?: ProbeApi; oracle?: unknown };
  }
}

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  { cell, api, control = false, reconnects, listed, manual },
  ref,
) {
  const support = frameTapSupport();
  const canvas = useRef<StageCanvasHandle>(null);
  const presentedAt = useRef(0);
  const [generation, setGeneration] = useState(0);
  const cellId = cell?.id ?? null;
  const ready = cell?.state === "ready" && !cell.paused;
  const owner = useMemo(
    () => ({ api, cellId, ready, generation, reconnects }),
    [api, cellId, ready, generation, reconnects],
  );
  const currentOwner = useRef(owner);
  const sourceOwner = useRef<typeof owner | null>(null);
  const [ticket, setTicket] = useState<{ owner: typeof owner; src: string } | null>(null);
  const [displayOwner, setDisplayOwner] = useState<typeof owner | null>(null);
  const src = ticket?.owner === owner ? ticket.src : null;
  useLayoutEffect(() => {
    currentOwner.current = owner;
    sourceOwner.current = null;
    presentedAt.current = 0;
    setDisplayOwner(null);
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
      .post<{ path: string }>(`/api/cells/${cellId}/stream-ticket?g=${generation}.${reconnects}`)
      .then(
        ({ path }) => {
          if (
            !cancelled &&
            path.startsWith(`/cells/${cellId}/desktop/`) &&
            /^\/cells\/[^/]+\/desktop\/[A-Za-z0-9_-]{22}\/$/.test(path)
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
  }, [api, cellId, ready, support.ok, generation, reconnects, owner]);

  // Overlays freeze while the stream is not live (spec, error handling); zoom comes from ?zoom= for tests.
  const reconnecting =
    !cell?.paused &&
    (cell?.stream.connection === "stalled" || cell?.stream.connection === "disconnected");
  const paused = !!cell?.paused || reconnecting;
  const manualActive = Boolean(manual);
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
    pushEvents: (events) => canvas.current?.pushEvents(events),
    resetSession: () => canvas.current?.resetSession(),
    setClock: (clock) => canvas.current?.setClock(clock),
    setView: (view) => canvas.current?.setView(manual ? { ...view, zoom: 1 } : view),
    oracle: (command) => canvas.current?.oracle(command) ?? Promise.resolve(undefined),
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
        <p>Reconnecting…</p>
      </div>
      {control && <div className="rim" aria-hidden="true" />}
      {manual && (
        <button
          type="button"
          className="manual-surface"
          aria-label="Click on the computer"
          disabled={!manual.enabled || !ready || reconnecting || !src || displayOwner !== owner}
          onClick={(event) => {
            if (
              !manual.enabled ||
              !ready ||
              reconnecting ||
              !src ||
              displayOwner !== owner ||
              event.detail === 0
            )
              return;
            const point = canvas.current?.manualPoint(
              { x: event.clientX, y: event.clientY },
              manual.screen,
            );
            if (point)
              void manual.input(manual.requestId, {
                kind: "click",
                at: point,
                button: manual.button,
                count: manual.count,
              });
          }}
          onKeyDown={(event) => {
            if (
              !manual.enabled ||
              !ready ||
              reconnecting ||
              !src ||
              displayOwner !== owner ||
              event.nativeEvent.isComposing
            )
              return;
            const combo = manualKey(event.key, event);
            if (combo) {
              event.preventDefault();
              void manual.input(manual.requestId, { kind: "key", combo });
            }
          }}
        />
      )}
    </>
  );
});
