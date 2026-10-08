import { chapters, observeAt, playAt, playDuration, sessionAt, ticks } from "@localdot/stage";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "./ReplayImage.tsx";
import { scrubberModel, timeLabel } from "./replay-view.ts";
import type { ReplayState } from "./useReplay.ts";

export function Scrubber({
  api,
  sessionId,
  replay,
}: {
  api: ApiClient;
  sessionId: string;
  replay: ReplayState;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seek = useRef(replay.seek);
  seek.current = replay.seek;
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const update = () => setWidth(node.getBoundingClientRect().width || 600);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      clearTimeout(settleTimer.current);
    };
  }, []);
  const view = useMemo(
    () =>
      replay.map
        ? scrubberModel({
            chapters: chapters(replay.model, replay.map.endMs),
            ticks: ticks(replay.model),
            map: replay.map,
            gaps: replay.info?.manifest.gaps ?? [],
            widthPx: width,
          })
        : null,
    [replay.map, replay.model, replay.info, width],
  );
  const map = replay.map;
  const duration = map ? playDuration(map) : 0;
  const fraction = (time: number) => (map && duration ? playAt(map, time) / duration : 0);
  const positionAt = (clientX: number) => {
    const bounds = track.current?.getBoundingClientRect();
    return map && bounds?.width
      ? sessionAt(map, Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) * duration)
      : 0;
  };
  const flush = () => {
    clearTimeout(settleTimer.current);
    settleTimer.current = undefined;
  };
  const preview = (time: number) => {
    flush();
    seek.current(time, "preview");
    settleTimer.current = setTimeout(() => {
      settleTimer.current = undefined;
      seek.current(time, "exact");
    }, 120);
  };
  const hovered = hover === null ? undefined : observeAt(replay.model, hover, replay.screen);
  const labelAt = (time: number) =>
    view?.chapters.findLast((chapter) => chapter.startT <= time)?.label ?? "Session start";
  return (
    <div className="replay-scrubber">
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Replay timeline"
        aria-valuemin={map?.startMs ?? 0}
        aria-valuemax={map?.endMs ?? 0}
        aria-valuenow={Math.round(replay.tMs)}
        aria-valuetext={`${timeLabel(replay.tMs)} of ${timeLabel(map?.endMs ?? 0)}, ${labelAt(replay.tMs)}`}
        aria-disabled={!map}
        className="replay-track"
        data-duration-ms={view?.durationPlayMs ?? 0}
        onPointerDown={(event) => {
          if (!map || event.button !== 0) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          flush();
          const time = positionAt(event.clientX);
          setHover(time);
          preview(time);
        }}
        onPointerMove={(event) => {
          const time = positionAt(event.clientX);
          setHover(time);
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          preview(time);
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          flush();
          replay.seek(positionAt(event.clientX), "exact");
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          flush();
          replay.seek(replay.tMs, "exact");
          setHover(null);
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(event) => {
          if (!map || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          replay.seek(
            event.key === "Home"
              ? map.startMs
              : event.key === "End"
                ? map.endMs
                : replay.tMs + (event.key === "ArrowLeft" ? -1000 : 1000),
            "exact",
          );
        }}
      >
        <span className="replay-track-played" style={{ width: `${fraction(replay.tMs) * 100}%` }} />
        {view?.chapters.map((chapter) => (
          <span
            key={chapter.id}
            className="replay-chapter"
            data-testid="replay-chapter"
            data-status={chapter.status}
            style={{ left: `${chapter.x0 * 100}%`, width: `${(chapter.x1 - chapter.x0) * 100}%` }}
            title={chapter.label}
          />
        ))}
        {view?.idle.map((band) => (
          <span
            key={band.x0}
            className="replay-idle-band"
            style={{ left: `${band.x0 * 100}%`, width: `${(band.x1 - band.x0) * 100}%` }}
            title={`${timeLabel(band.skippedMs)} idle skipped`}
          />
        ))}
        {view?.gaps.map((band) => (
          <span
            key={`${band.x0}-${band.reason}`}
            className="replay-gap-band"
            style={{ left: `${band.x0 * 100}%`, width: `${(band.x1 - band.x0) * 100}%` }}
            title={band.reason}
          />
        ))}
        {view?.ticks.map((tick) => (
          <span
            key={tick.x}
            className={`replay-tick ${tick.tone}`}
            style={{ left: `${tick.x * 100}%` }}
            title={`${tick.kinds.join(", ")}: ${tick.label}`}
          />
        ))}
        <span className="replay-playhead" style={{ left: `${fraction(replay.tMs) * 100}%` }} />
      </div>
      {hover !== null && (
        <div
          className="replay-hover"
          style={{
            left: `${Math.max(Math.min(90, width / 2), Math.min(width - Math.min(90, width / 2), fraction(hover) * width))}px`,
          }}
        >
          <ReplayImage api={api} sessionId={sessionId} frameId={hovered?.frameId ?? null} />
          <strong>{timeLabel(hover)}</strong>
          <span>{labelAt(hover)}</span>
        </div>
      )}
    </div>
  );
}
