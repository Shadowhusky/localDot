import {
  chapters,
  observeAt,
  type PlaybackMap,
  playAt,
  playDuration,
  playMsAt,
  type ReplayClock,
  sessionAt,
  ticks,
} from "@localdot/stage";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "./ReplayImage.tsx";
import { scrubberModel, timeLabel } from "./replay-view.ts";
import type { ReplayState } from "./useReplay.ts";

// The worker reports the time about ten times a second. Between reports the playhead runs on its own
// clock, and a report this close to that clock leaves it alone, so the head never steps back.
const DRIFT_MS = 250;
const PREVIEW_HALF = 104;
const KEY_STEPS: Record<string, number> = {
  ArrowLeft: -1000,
  ArrowRight: 1000,
  PageDown: -10_000,
  PageUp: 10_000,
};

type Clock = ReplayClock & { map: PlaybackMap | null };

const span = (x0: number, x1: number): CSSProperties => ({
  left: `${x0 * 100}%`,
  width: `${(x1 - x0) * 100}%`,
});

export function Scrubber({
  api,
  sessionId,
  replay,
}: {
  api: ApiClient;
  sessionId: string;
  replay: ReplayState;
}) {
  const slider = useRef<HTMLDivElement>(null);
  const played = useRef<HTMLSpanElement>(null);
  const head = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const resume = useRef(false);
  const clock = useRef<Clock>({
    playing: false,
    speed: 1,
    anchorWallMs: 0,
    anchorPlayMs: 0,
    map: null,
  });
  const latest = useRef(replay);
  latest.current = replay;
  const map = replay.map;
  const duration = map ? playDuration(map) : 0;

  const paint = (fraction: number) => {
    const f = Math.max(0, Math.min(1, fraction));
    if (played.current) played.current.style.transform = `scaleX(${f})`;
    if (head.current)
      head.current.style.transform = `translateX(${Math.round(f * width * 100) / 100}px)`;
  };
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const clockFraction = (now: number) => (duration ? playMsAt(clock.current, now) / duration : 0);

  useEffect(() => {
    const node = slider.current;
    if (!node) return;
    const update = () => setWidth(node.getBoundingClientRect().width || 600);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the clock re-anchors on each report.
  useEffect(() => {
    const now = performance.now();
    const reported = map ? playAt(map, replay.tMs) : 0;
    const current = clock.current;
    const steady =
      replay.playing &&
      current.playing &&
      current.speed === replay.speed &&
      current.map === map &&
      Math.abs(playMsAt(current, now) - reported) < DRIFT_MS;
    if (!steady)
      clock.current = {
        playing: replay.playing,
        speed: replay.speed,
        anchorWallMs: now,
        anchorPlayMs: reported,
        map,
      };
    if (!dragging) paintRef.current(clockFraction(now));
  }, [map, duration, replay.tMs, replay.playing, replay.speed, dragging, width]);

  useEffect(() => {
    if (!replay.playing || dragging || !duration) return;
    let frame = requestAnimationFrame(function tick(now) {
      paintRef.current(playMsAt(clock.current, now) / duration);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [replay.playing, dragging, duration]);

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
  const fraction = (time: number) => (map && duration ? playAt(map, time) / duration : 0);
  const timeAt = (clientX: number) => {
    const bounds = slider.current?.getBoundingClientRect();
    return map && bounds?.width
      ? sessionAt(map, Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) * duration)
      : 0;
  };
  // The head follows the finger on every move; the stage shows key frames until the finger lets go.
  const preview = (time: number) => {
    paint(fraction(time));
    latest.current.seek(time, "preview");
  };
  const release = (time: number) => {
    setDragging(false);
    latest.current.seek(time, "exact");
    if (resume.current) latest.current.run({ kind: "toggle-play" });
    resume.current = false;
  };
  // The preview fades out where it was, still showing the moment it showed.
  const lastHover = useRef<number | null>(null);
  if (hover !== null) lastHover.current = hover;
  const shownAt = lastHover.current ?? 0;
  const hovered =
    lastHover.current === null ? undefined : observeAt(replay.model, shownAt, replay.screen);
  const labelAt = (time: number) =>
    view?.chapters.findLast((chapter) => chapter.startT <= time)?.label ?? "Start";
  const half = Math.min(PREVIEW_HALF, width / 2);
  const previewX = Math.max(half, Math.min(width - half, fraction(shownAt) * width));
  return (
    <div className="replay-scrubber">
      <div
        ref={slider}
        role="slider"
        tabIndex={0}
        aria-label="Replay timeline"
        aria-valuemin={map?.startMs ?? 0}
        aria-valuemax={map?.endMs ?? 0}
        aria-valuenow={Math.round(replay.tMs)}
        aria-valuetext={`${timeLabel(replay.tMs)} of ${timeLabel(map?.endMs ?? 0)}, ${labelAt(replay.tMs)}`}
        aria-description={
          replay.selection
            ? `Marked ${timeLabel(replay.selection.fromMs)} to ${timeLabel(replay.selection.toMs)}`
            : undefined
        }
        aria-disabled={!map}
        className="replay-scrub"
        data-dragging={dragging ? "" : undefined}
        data-duration-ms={view?.durationPlayMs ?? 0}
        onPointerDown={(event) => {
          if (!map || event.button !== 0) return;
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          resume.current = latest.current.playing;
          setDragging(true);
          const time = timeAt(event.clientX);
          setHover(time);
          preview(time);
        }}
        onPointerMove={(event) => {
          const capturing = event.currentTarget.hasPointerCapture(event.pointerId);
          if (!capturing && event.pointerType === "touch") return;
          const time = timeAt(event.clientX);
          setHover(time);
          if (capturing) preview(time);
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          release(timeAt(event.clientX));
          event.currentTarget.releasePointerCapture(event.pointerId);
          if (event.pointerType === "touch") setHover(null);
        }}
        onPointerCancel={() => {
          if (dragging) release(latest.current.tMs);
          setHover(null);
        }}
        onPointerLeave={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) setHover(null);
        }}
        onKeyDown={(event) => {
          const step = KEY_STEPS[event.key];
          if (!map || (step === undefined && event.key !== "Home" && event.key !== "End")) return;
          event.preventDefault();
          event.stopPropagation();
          replay.seek(
            event.key === "Home"
              ? map.startMs
              : event.key === "End"
                ? map.endMs
                : replay.tMs + (step ?? 0),
            "exact",
          );
        }}
      >
        {replay.selection && (
          <span
            className="replay-selection"
            data-testid="replay-selection"
            style={span(fraction(replay.selection.fromMs), fraction(replay.selection.toMs))}
            aria-hidden="true"
          />
        )}
        <div className="replay-track">
          <span ref={played} className="replay-played" />
          {view?.idle.map((band) => (
            <span key={band.x0} className="replay-idle" style={span(band.x0, band.x1)} />
          ))}
          {view?.gaps.map((band) => (
            <span
              key={`${band.x0}-${band.reason}`}
              className="replay-gap"
              style={span(band.x0, band.x1)}
            />
          ))}
          {view?.chapters.map((chapter) => (
            <span
              key={chapter.id}
              className="replay-chapter"
              data-testid="replay-chapter"
              data-status={chapter.status}
              style={span(chapter.x0, chapter.x1)}
            />
          ))}
        </div>
        {view?.ticks
          .filter((tick) => tick.tone !== "neutral")
          .map((tick) => (
            <span
              key={tick.x}
              className="replay-landmark"
              data-tone={tick.tone}
              style={{ left: `${tick.x * 100}%` }}
              aria-hidden="true"
            />
          ))}
        <span ref={head} className="replay-playhead" aria-hidden="true">
          <span className="replay-knob" />
        </span>
      </div>
      <div
        className="replay-preview-pop"
        data-shown={hover !== null ? "" : undefined}
        style={{ transform: `translateX(${previewX}px)` }}
        aria-hidden="true"
      >
        <ReplayImage api={api} sessionId={sessionId} frameId={hovered?.frameId ?? null} />
        <span className="replay-preview-pop-meta">
          <span className="num">{timeLabel(shownAt)}</span>
          <span className="replay-preview-pop-label">{labelAt(shownAt)}</span>
        </span>
      </div>
    </div>
  );
}
