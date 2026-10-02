import type { LocalDotEvent } from "@localdot/protocol";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";
import { forgetOldTickets } from "./client-storage.ts";
import { DesktopFrame } from "./DesktopFrame.tsx";
import { type FrameSource, frameTapSupport } from "./frame-source.ts";
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
}

declare global {
  interface Window {
    __localdot?: { probe?: ProbeApi; oracle?: unknown };
  }
}

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(
  { cell, api, control = false, reconnects, listed },
  ref,
) {
  const support = frameTapSupport();
  const canvas = useRef<StageCanvasHandle>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const cellId = cell?.id ?? null;
  const ready = cell?.state === "ready";
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
      setSrc(null);
      canvas.current?.detach();
      return;
    }
    let cancelled = false;
    api
      .post<{ path: string }>(`/api/cells/${cellId}/stream-ticket?g=${generation}.${reconnects}`)
      .then(
        ({ path }) => {
          if (!cancelled) {
            forgetOldTickets({ cellId, livePath: path, listed: listedRef.current });
            setSrc(path);
          }
        },
        () => {},
      );
    return () => {
      cancelled = true;
    };
  }, [api, cellId, ready, support.ok, generation, reconnects]);

  // Overlays freeze while the stream is not live (spec, error handling); zoom comes from ?zoom= for tests.
  const paused =
    cell?.stream.connection === "stalled" || cell?.stream.connection === "disconnected";
  useEffect(() => {
    canvas.current?.setView({ freeze: paused, zoom: Number(params.get("zoom") ?? 1) || 1 });
  }, [paused, params]);

  const onSource = useCallback((source: FrameSource) => {
    if (canvas.current) canvas.current.attach(source);
    else source.stop();
  }, []);
  const onLost = useCallback(() => setGeneration((g) => g + 1), []);
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
    setView: (view) => canvas.current?.setView(view),
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
      <StageCanvas ref={canvas} onFlip={onFlip} />
      {src && (
        <DesktopFrame
          key={`${src} ${generation}.${reconnects}`}
          src={src}
          onSource={onSource}
          onStale={onLost}
        />
      )}
      <div className={paused ? "stage-veil on" : "stage-veil"} aria-hidden={!paused}>
        <p>Reconnecting…</p>
      </div>
      {control && <div className="rim" aria-hidden="true" />}
    </>
  );
});
