import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../../ui/IconButton.tsx";
import { SegmentedControl } from "../../ui/SegmentedControl.tsx";
import { ViewerBar, ViewerLoading, ViewerMessage } from "./states.tsx";
import {
  centred,
  dragged,
  fitScale,
  MAX_SCALE,
  minScale,
  project,
  type Size,
  settle,
  type View,
  zoomAt,
  zoomedIn,
} from "./zoom.ts";

const STEP = 1.25;
// A pointer's place on the stage.
function inside(stage: HTMLElement | null, event: { clientX: number; clientY: number }) {
  const box = stage?.getBoundingClientRect();
  return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
}
const CHECKER = 16;
type Mode = "fit" | "actual" | "free";

// A picture on a dark stage: shown whole at first, then zoomed with the buttons, a pinch, the
// trackpad or a double click, and dragged about once it is larger than the stage. Transparent parts
// show a checkerboard. An SVG is drawn as a picture too, never as part of the page.
export function PictureView({
  src,
  name,
  caption,
}: {
  src: string;
  name: string;
  caption?: ReactNode;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [stage, setStage] = useState<Size>({ w: 0, h: 0 });
  const [mode, setMode] = useState<Mode>("fit");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [scale, setScale] = useState(1);
  const view = useRef<View>({ scale: 1, x: 0, y: 0 });
  const sizes = useRef({ picture: { w: 0, h: 0 }, stage: { w: 0, h: 0 } });
  sizes.current = { picture: natural ?? { w: 0, h: 0 }, stage };

  const apply = useCallback((next: View, animate: boolean) => {
    view.current = next;
    const canvas = canvasRef.current;
    const host = stageRef.current;
    if (!canvas || !host) return;
    canvas.toggleAttribute("data-settling", animate);
    canvas.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
    canvas.style.setProperty("--_checker", `${CHECKER / next.scale}px`);
    canvas.toggleAttribute("data-pixels", next.scale >= 3);
    const { picture, stage: room } = sizes.current;
    host.toggleAttribute("data-zoomed", zoomedIn(next, picture, room));
    setScale(next.scale);
  }, []);

  useLayoutEffect(() => {
    const host = stageRef.current;
    if (!host) return;
    const measure = () => {
      const next = { w: host.clientWidth, h: host.clientHeight };
      setStage((was) => (was.w === next.w && was.h === next.h ? was : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Measured in the next frame, so a resize never lays the page out again inside its own report.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // Shown whole again whenever the stage changes size, or kept in bounds when zoomed.
  useLayoutEffect(() => {
    if (!natural || !stage.w) return;
    if (modeRef.current === "fit") apply(centred(natural, stage, fitScale(natural, stage)), false);
    else apply(settle(view.current, natural, stage), false);
  }, [natural, stage, apply]);

  const zoomTo = (next: number, px = stage.w / 2, py = stage.h / 2, animate = true) => {
    if (!natural) return;
    const clamped = Math.min(MAX_SCALE, Math.max(minScale(natural, stage), next));
    setMode(clamped === 1 ? "actual" : "free");
    apply(settle(zoomAt(view.current, clamped, px, py), natural, stage), animate);
  };
  const fit = () => {
    if (!natural) return;
    setMode("fit");
    apply(centred(natural, stage, fitScale(natural, stage)), true);
  };

  // Pointers on the stage: one drags a zoomed picture, two pinch. One finger on a picture shown whole
  // is left to the viewer, which turns to the next file.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    start: View;
    from: { x: number; y: number };
    distance: number;
    moves: { t: number; x: number; y: number }[];
  } | null>(null);
  const local = (event: { clientX: number; clientY: number }) => inside(stageRef.current, event);
  const begin = () => {
    const points = [...pointers.current.values()];
    const [a, b] = points;
    if (!a) return;
    const mid = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
    gesture.current = {
      start: view.current,
      from: mid,
      distance: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
      moves: [{ t: performance.now(), ...mid }],
    };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!natural || (event.pointerType === "mouse" && event.button !== 0)) return;
    pointers.current.set(event.pointerId, local(event));
    const zoomed = zoomedIn(view.current, natural, stage);
    if (pointers.current.size === 1 && !zoomed) {
      // Retain the first contact so the next one can start a pinch from Fit.
      // It may still bubble to file paging until a second finger joins.
      return;
    }
    // Let the viewer see the second contact so it cancels single-finger paging.
    if (pointers.current.size === 1) event.stopPropagation();
    for (const id of pointers.current.keys()) event.currentTarget.setPointerCapture(id);
    begin();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, local(event));
    const g = gesture.current;
    if (!g || !natural) return;
    event.stopPropagation();
    const [a, b] = [...pointers.current.values()];
    if (!a) return;
    const mid = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
    g.moves = [...g.moves.slice(-4), { t: performance.now(), ...mid }];
    let next = g.start;
    if (b && g.distance > 0) {
      const wanted = g.start.scale * (Math.hypot(a.x - b.x, a.y - b.y) / g.distance);
      next = zoomAt(
        g.start,
        Math.min(MAX_SCALE * 1.5, Math.max(minScale(natural, stage) * 0.6, wanted)),
        g.from.x,
        g.from.y,
      );
    }
    next = { ...next, x: next.x + mid.x - g.from.x, y: next.y + mid.y - g.from.y };
    setMode("free");
    apply(dragged(next, natural, stage), false);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size > 0) {
      begin();
      return;
    }
    gesture.current = null;
    if (!g || !natural) return;
    const clamped = Math.min(MAX_SCALE, Math.max(minScale(natural, stage), view.current.scale));
    let next = zoomAt(view.current, clamped, g.from.x, g.from.y);
    const first = g.moves[0];
    const last = g.moves.at(-1);
    if (event.type !== "pointercancel" && first && last && last.t > first.t) {
      const ms = last.t - first.t;
      next = {
        ...next,
        x: next.x + project(((last.x - first.x) / ms) * 1000),
        y: next.y + project(((last.y - first.y) / ms) * 1000),
      };
    }
    apply(settle(next, natural, stage), true);
  };

  // A pinch on the trackpad zooms about the pointer; two fingers move a zoomed picture.
  useEffect(() => {
    const host = stageRef.current;
    if (!host || !natural) return;
    const onWheel = (event: WheelEvent) => {
      const room = { w: host.clientWidth, h: host.clientHeight };
      const at = inside(host, event);
      if (event.ctrlKey) {
        event.preventDefault();
        const next = Math.min(
          MAX_SCALE,
          Math.max(minScale(natural, room), view.current.scale * Math.exp(-event.deltaY * 0.01)),
        );
        setMode("free");
        apply(settle(zoomAt(view.current, next, at.x, at.y), natural, room), false);
      } else if (zoomedIn(view.current, natural, room)) {
        event.preventDefault();
        const moved = {
          ...view.current,
          x: view.current.x - event.deltaX,
          y: view.current.y - event.deltaY,
        };
        apply(settle(moved, natural, room), false);
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [natural, apply]);

  const percent = `${Math.round(scale * 100)}%`;
  const ready = natural !== null && stage.w > 0 && stage.h > 0;
  return (
    <>
      <ViewerBar
        note={
          natural && natural.w > 0 ? (
            <span className="num">
              {natural.w} × {natural.h}
            </span>
          ) : undefined
        }
      >
        <SegmentedControl
          size={28}
          aria-label="Zoom"
          value={mode === "free" ? "" : mode}
          items={[
            { value: "fit", label: "Fit" },
            { value: "actual", label: "Actual size" },
          ]}
          onValueChange={(value) => (value === "fit" ? fit() : zoomTo(1))}
        />
        <div className="viewer-zoom">
          <IconButton
            icon="minus"
            size={28}
            label="Zoom out"
            disabledReason={
              !ready || (natural && scale <= minScale(natural, stage) + 0.001)
                ? "Shown whole"
                : undefined
            }
            onClick={() => zoomTo(scale / STEP)}
          />
          <span className="viewer-zoom-value num" aria-live="polite">
            {percent}
          </span>
          <IconButton
            icon="plus"
            size={28}
            label="Zoom in"
            disabledReason={
              !ready || scale >= MAX_SCALE - 0.001 ? "Zoomed in all the way" : undefined
            }
            onClick={() => zoomTo(scale * STEP)}
          />
        </div>
      </ViewerBar>
      {failed ? (
        <ViewerMessage name={name} title="Can't show this picture">
          It may be damaged or in a format this browser can't draw.
        </ViewerMessage>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: The stage takes pinches and drags; the bar's buttons zoom by keyboard.
        <div
          ref={stageRef}
          className="viewer-stage viewer-picture"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
          onDoubleClick={(event) => {
            if (!natural) return;
            const at = local(event);
            if (mode === "fit" && fitScale(natural, stage) < 1) zoomTo(1, at.x, at.y);
            else if (mode === "fit") zoomTo(Math.min(MAX_SCALE, 2), at.x, at.y);
            else fit();
          }}
        >
          <div
            ref={canvasRef}
            className="viewer-canvas"
            data-ready={ready || undefined}
            style={natural ? { width: natural.w, height: natural.h } : undefined}
          >
            <img
              src={src}
              alt={name}
              draggable={false}
              decoding="async"
              onLoad={(event) => {
                const image = event.currentTarget;
                const room = stageRef.current;
                // An SVG with no size of its own fills the stage.
                setNatural(
                  image.naturalWidth > 0
                    ? { w: image.naturalWidth, h: image.naturalHeight }
                    : { w: room?.clientWidth ?? 800, h: room?.clientHeight ?? 600 },
                );
              }}
              onError={() => setFailed(true)}
            />
          </div>
          {!ready && <ViewerLoading label="Loading picture" />}
          {caption && <p className="viewer-caption">{caption}</p>}
        </div>
      )}
    </>
  );
}
