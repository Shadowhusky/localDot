import type { ScreenName } from "@localdot/protocol";
import type { SessionModel } from "@localdot/stage";
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import { timeLabel } from "../replay/replay-view.ts";
import { useMediaQuery } from "../ui/media.ts";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import {
  dragEdge,
  edgeLimits,
  filmstrip,
  fitTrim,
  moveEdge,
  nudgeEdge,
  parseTrimTime,
  SNAP_PX,
  shortcutOf,
  stepEdges,
  stepSpans,
  type TrimEdge,
  type TrimRange,
  type TrimShortcut,
  tileCount,
  timeAtX,
  trimTimeLabel,
} from "./trim.ts";

export interface TrimHold {
  edge: TrimEdge;
  dragging: boolean;
}

export const EDGE_LABEL: Record<TrimEdge, string> = { from: "Start", to: "End" };

const SHORTCUT_LABEL: Record<TrimShortcut, string> = {
  whole: "Whole",
  chapter: "This step",
  selection: "Selection",
};

// The part of the recording that goes in the video: a strip of its key frames with a handle at each
// end, the two times typed or nudged, and Whole, This step and Selection to set both at once.
export function Trim({
  api,
  sessionId,
  model,
  screen,
  whole,
  shortcuts,
  unavailable,
  range,
  onRange,
  snap,
  onSnap,
  onHold,
}: {
  api: ApiClient;
  sessionId: string;
  model: SessionModel;
  screen: ScreenName;
  whole: TrimRange;
  shortcuts: Record<TrimShortcut, TrimRange | null>;
  // Why a shortcut can't be chosen, while it can't.
  unavailable: Partial<Record<TrimShortcut, string>>;
  range: TrimRange;
  // `edge` is the end that moved, or the start when a shortcut set both.
  onRange(range: TrimRange, edge: TrimEdge): void;
  snap: boolean;
  onSnap(snap: boolean): void;
  // A handle held by the pointer, or focused from the keyboard.
  onHold(hold: TrimHold | null): void;
}) {
  const coarse = useMediaQuery("(pointer: coarse)");
  const strip = useRef<HTMLDivElement>(null);
  const film = useRef<HTMLDivElement>(null);
  const [filmSize, setFilmSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState<TrimEdge | null>(null);
  const [snapped, setSnapped] = useState<number | null>(null);
  const steps = useMemo(() => stepSpans(model, whole), [model, whole]);
  const edges = useMemo(() => stepEdges(steps, whole), [steps, whole]);
  const tiles = useMemo(
    () => filmstrip(model, whole, screen, tileCount(filmSize.w, filmSize.h)),
    [model, whole, screen, filmSize.w, filmSize.h],
  );
  const latest = useRef({ range, whole, edges, snap, coarse, onRange, onHold });
  latest.current = { range, whole, edges, snap, coarse, onRange, onHold };

  // Measured before the first paint, so the handles open where they belong instead of gliding there.
  useLayoutEffect(() => {
    const node = film.current;
    if (!node) return;
    const measure = () => setFilmSize({ w: node.clientWidth, h: node.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Native listeners, so a press on a handle never reaches the sheet's own drag to close.
  useEffect(() => {
    const root = strip.current;
    if (!root) return;
    let drag: { edge: TrimEdge; id: number; grab: number } | null = null;
    const track = () => film.current?.getBoundingClientRect() ?? null;
    const xOf = (time: number, bounds: DOMRect, span: TrimRange) =>
      bounds.left +
      (span.toMs > span.fromMs
        ? ((time - span.fromMs) / (span.toMs - span.fromMs)) * bounds.width
        : 0);

    const down = (event: PointerEvent) => {
      const handle =
        event.target instanceof Element ? event.target.closest<HTMLElement>("[data-edge]") : null;
      if (!handle || drag || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.stopPropagation();
      const bounds = track();
      if (!bounds) return;
      const edge = handle.dataset.edge as TrimEdge;
      const { range: held, whole: span, onRange: report, onHold: hold } = latest.current;
      const face = handle.getBoundingClientRect();
      // A handle still gliding to a shortcut is caught where it shows.
      const gliding = (handle.parentElement?.getAnimations?.().length ?? 0) > 0;
      const at = gliding
        ? edge === "from"
          ? face.right
          : face.left
        : xOf(edge === "from" ? held.fromMs : held.toMs, bounds, span);
      if (gliding) report(moveEdge(held, span, edge, timeAtX(at, bounds, span)), edge);
      drag = { edge, id: event.pointerId, grab: event.clientX - at };
      setDragging(edge);
      hold({ edge, dragging: true });
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {}
    };

    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const bounds = track();
      if (!bounds) return;
      const {
        range: held,
        whole: span,
        edges: stops,
        snap: snapping,
        coarse: touch,
      } = latest.current;
      const reachMs =
        bounds.width > 0
          ? ((touch ? SNAP_PX.coarse : SNAP_PX.fine) * (span.toMs - span.fromMs)) / bounds.width
          : 0;
      const result = dragEdge(
        held,
        span,
        drag.edge,
        timeAtX(event.clientX - drag.grab, bounds, span),
        snapping ? { edges: stops, reachMs } : null,
      );
      setSnapped(result.snapped);
      latest.current.onRange(result.range, drag.edge);
    };

    const end = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      setDragging(null);
      setSnapped(null);
      latest.current.onHold(null);
    };

    root.addEventListener("pointerdown", down);
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    root.addEventListener("lostpointercapture", end);
    return () => {
      root.removeEventListener("pointerdown", down);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerup", end);
      root.removeEventListener("pointercancel", end);
      root.removeEventListener("lostpointercapture", end);
    };
  }, []);

  const span = whole.toMs - whole.fromMs;
  const share = (time: number) => (span > 0 ? (time - whole.fromMs) / span : 0);
  const shortcut = shortcutOf(range, shortcuts, whole);

  const handle = (edge: TrimEdge) => {
    const at = edge === "from" ? range.fromMs : range.toMs;
    const limits = edgeLimits(range, whole, edge);
    return (
      <span className="trim-rail" data-rail={edge}>
        <span
          role="slider"
          tabIndex={0}
          className="trim-handle"
          data-edge={edge}
          aria-label={EDGE_LABEL[edge]}
          aria-orientation="horizontal"
          aria-valuemin={limits.min}
          aria-valuemax={limits.max}
          aria-valuenow={at}
          aria-valuetext={trimTimeLabel(at)}
          onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
            const next = nudgeEdge(range, whole, edge, event, edges);
            if (!next) return;
            event.preventDefault();
            event.stopPropagation();
            onRange(next, edge);
          }}
          onFocus={(event: FocusEvent<HTMLSpanElement>) => {
            if (!dragging && focusVisible(event.currentTarget)) onHold({ edge, dragging: false });
          }}
          onBlur={() => {
            if (!dragging) onHold(null);
          }}
        />
      </span>
    );
  };

  return (
    <div className="trim">
      <div
        ref={strip}
        className="trim-strip"
        data-dragging={dragging ?? undefined}
        style={
          {
            "--_from": share(range.fromMs),
            "--_to": share(range.toMs),
            "--_film": `${filmSize.w}px`,
          } as CSSProperties
        }
      >
        <div ref={film} className="trim-film" aria-hidden="true">
          <span className="trim-tiles">
            {tiles.map((frameId, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a tile is its place on the strip.
              <span key={index} className="trim-tile">
                <ReplayImage api={api} sessionId={sessionId} frameId={frameId} />
              </span>
            ))}
          </span>
          <span className="trim-shade" data-side="from" />
          <span className="trim-shade" data-side="to" />
          <span className="trim-frame" />
        </div>
        {handle("from")}
        {handle("to")}
        <span className="trim-steps" aria-hidden="true">
          {steps.map((step) => (
            <span
              key={step.fromMs}
              className="trim-step"
              data-snapped={snapped === step.fromMs || snapped === step.toMs ? "" : undefined}
              style={{
                left: `${share(step.fromMs) * 100}%`,
                width: `${(share(step.toMs) - share(step.fromMs)) * 100}%`,
              }}
            />
          ))}
        </span>
      </div>
      <div className="trim-times">
        <TrimTime
          edge="from"
          value={range.fromMs}
          onTime={(time) => onRange(moveEdge(range, whole, "from", time), "from")}
        />
        <span className="trim-length num">
          {timeLabel(range.toMs - range.fromMs)} of {timeLabel(span)}
        </span>
        <TrimTime
          edge="to"
          value={range.toMs}
          onTime={(time) => onRange(moveEdge(range, whole, "to", time), "to")}
        />
      </div>
      <div className="trim-shortcuts">
        <SegmentedControl
          size={24}
          aria-label="Range"
          items={(["whole", "chapter", "selection"] as const).map((name) => ({
            value: name,
            label: SHORTCUT_LABEL[name],
            disabledReason: shortcuts[name] ? undefined : unavailable[name],
          }))}
          value={shortcut ?? ""}
          onValueChange={(name) => {
            const chosen = shortcuts[name as TrimShortcut];
            if (chosen) onRange(fitTrim(chosen, whole), "from");
          }}
        />
        <Switch
          className="trim-snap"
          label="Snap to steps"
          checked={snap}
          onCheckedChange={onSnap}
        />
      </div>
    </div>
  );
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

// A time typed in place: it applies on Return or on leaving the field; Escape puts it back.
function TrimTime({
  edge,
  value,
  onTime,
}: {
  edge: TrimEdge;
  value: number;
  onTime(time: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const typed = parseTrimTime(draft);
    setDraft(null);
    if (typed !== null) onTime(typed);
  };
  return (
    <TextField
      size="sm"
      className="trim-time num"
      prefix={EDGE_LABEL[edge]}
      aria-label={`${EDGE_LABEL[edge]} time`}
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="done"
      value={draft ?? trimTimeLabel(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape" && draft !== null) {
          event.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}
