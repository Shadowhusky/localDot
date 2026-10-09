import { type SpringParams, springValue } from "@localdot/stage";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { springVelocity } from "../../dot/engine/spring.ts";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { useLayer } from "../../ui/LayerStack.tsx";
import { matches, PHONE, REDUCED_MOTION, useMediaQuery } from "../../ui/media.ts";
import { PageCounter } from "./PageCounter.tsx";
import { type PageSize, PdfPage } from "./PdfPage.tsx";
import { clampPage, contain, keyTurn, turned } from "./paging.ts";
import { ViewerBar } from "./states.tsx";
import { Thumbs } from "./Thumbs.tsx";
import { viewerHears } from "./viewer-keys.ts";
import { rubberband, swipeTurn } from "./zoom.ts";

// Critically damped for a press or a key; a little give only after a flick (design-v2 §7).
const SETTLE: SpringParams = { dampingRatio: 1, response: 0.35 };
const MOMENTUM: SpringParams = { dampingRatio: 0.8, response: 0.35 };
const FLICK = 300;
// The present controls fade after this long without the pointer moving.
const CONTROLS_MS = 2500;
// Room between neighbouring slides beyond the stage's width, so no shadow reaches the one on show.
const APART = 96;

// A deck a slide at a time: the slide whole and centred, the arrows, a swipe or the strip moving
// between slides, "Slide 3 of 24", and Present to fill the screen with it.
export function SlidesView({
  pdf,
  sizes,
  lead,
}: {
  pdf: PDFDocumentProxy;
  sizes: readonly PageSize[];
  lead?: ReactNode;
}) {
  const phone = useMediaQuery(PHONE);
  const count = sizes.length;
  const host = useRef<HTMLDivElement>(null);
  const [slide, setSlide] = useState(1);
  const [presenting, setPresenting] = useState(false);
  const go = useCallback((wanted: number) => setSlide(clampPage(wanted, count)), [count]);
  const slideRef = useRef(slide);
  slideRef.current = slide;

  useEffect(() => {
    if (presenting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !viewerHears(host.current, event.target)) return;
      const turn = keyTurn(event, "slides");
      if (!turn) return;
      event.preventDefault();
      go(turned(slideRef.current, turn, count));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, count, presenting]);

  const counter = <PageCounter page={slide} count={count} noun="Slide" onGo={go} />;
  const present = (
    <Button
      size={phone ? "md" : "sm"}
      variant="secondary"
      icon="presentation"
      onClick={() => setPresenting(true)}
    >
      Present
    </Button>
  );
  return (
    <>
      {(!phone || lead) && (
        <ViewerBar end={!phone && present}>
          {lead}
          {!phone && counter}
        </ViewerBar>
      )}
      <div ref={host} className="viewer-stage viewer-slides">
        <SlideTrack pdf={pdf} sizes={sizes} slide={slide} onSlide={go} margin={phone ? 16 : 40} />
        {count > 1 && (
          <Thumbs
            pdf={pdf}
            sizes={sizes}
            current={slide}
            axis="x"
            height={phone ? 44 : 56}
            numbered={!phone}
            noun="Slide"
            onPick={go}
          />
        )}
      </div>
      {phone && (
        <div className="viewer-pager-bar">
          {counter}
          <div className="viewer-pager-tools">{present}</div>
        </div>
      )}
      {presenting && (
        <Present
          pdf={pdf}
          sizes={sizes}
          slide={slide}
          onSlide={go}
          onClose={() => setPresenting(false)}
        />
      )}
    </>
  );
}

// The slides side by side a stage's width apart and more, the one on show centred. Its place is a float
// that a spring carries to each slide from wherever it is, so a press during a glide redirects it;
// a swipe moves it 1:1, gives less and less past either end, and is thrown on with its speed.
function SlideTrack({
  pdf,
  sizes,
  slide,
  onSlide,
  margin,
  onTap,
}: {
  pdf: PDFDocumentProxy;
  sizes: readonly PageSize[];
  slide: number;
  onSlide(slide: number): void;
  margin: number;
  // A press that did not move: -1 on the left third, 1 elsewhere.
  onTap?(side: -1 | 1): void;
}) {
  const count = sizes.length;
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const reduced = useMediaQuery(REDUCED_MOTION);
  const place = useRef(slide - 1);
  const speed = useRef(0);
  const goal = useRef(slide - 1);
  const frame = useRef(0);
  const [near, setNear] = useState<[number, number]>([slide - 2, slide]);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () =>
      setBox((was) =>
        was.w === element.clientWidth && was.h === element.clientHeight
          ? was
          : { w: element.clientWidth, h: element.clientHeight },
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let tick = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(tick);
      tick = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(tick);
      observer.disconnect();
    };
  }, []);

  const paint = useCallback(() => {
    const element = stage.current;
    if (!element) return;
    const pitch = element.clientWidth + APART;
    for (const child of element.querySelectorAll<HTMLElement>("[data-index]")) {
      const x = (Number(child.dataset.index) - place.current) * pitch;
      child.style.transform = `translate3d(${x}px, 0, 0)`;
    }
    const at = place.current;
    const next: [number, number] = reduced
      ? [Math.round(at), Math.round(at)]
      : [Math.max(0, Math.floor(at) - 1), Math.min(count - 1, Math.ceil(at) + 1)];
    setNear((was) => (was[0] === next[0] && was[1] === next[1] ? was : next));
  }, [count, reduced]);
  useLayoutEffect(() => paint());

  const glide = useCallback(
    (to: number, velocity: number, spring: SpringParams) => {
      cancelAnimationFrame(frame.current);
      goal.current = to;
      if (reduced) {
        place.current = to;
        speed.current = 0;
        paint();
        return;
      }
      const from = place.current;
      const start = performance.now();
      const step = (now: number) => {
        const t = (now - start) / 1000;
        place.current = springValue(from, to, velocity, t, spring);
        speed.current = springVelocity(from, to, velocity, t, spring);
        if (t > spring.response * 2 && Math.abs(place.current - to) < 0.001) {
          place.current = to;
          speed.current = 0;
          frame.current = 0;
        } else frame.current = requestAnimationFrame(step);
        paint();
      };
      frame.current = requestAnimationFrame(step);
    },
    [paint, reduced],
  );
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // A slide chosen anywhere else is glided to from wherever the track is, keeping its speed.
  useEffect(() => {
    if (slide - 1 !== goal.current) glide(slide - 1, speed.current, SETTLE);
  }, [slide, glide]);

  const press = useRef<{
    id: number;
    x: number;
    y: number;
    from: number;
    decided?: boolean;
    moves: { t: number; x: number }[];
  } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (press.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.stopPropagation();
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    press.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: place.current,
      moves: [],
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    const element = stage.current;
    if (!p || p.id !== event.pointerId || !element) return;
    event.stopPropagation();
    const dx = event.clientX - p.x;
    if (!p.decided) {
      if (Math.hypot(dx, event.clientY - p.y) < 10) return;
      if (event.pointerType === "mouse" || Math.abs(dx) < Math.abs(event.clientY - p.y)) {
        p.decided = false;
        return;
      }
      p.decided = true;
      element.setPointerCapture(event.pointerId);
    }
    if (!p.decided) return;
    p.moves = [...p.moves.slice(-5), { t: event.timeStamp, x: event.clientX }];
    const pitch = element.clientWidth + APART;
    const wanted = p.from - dx / pitch;
    const over = wanted < 0 ? wanted : wanted > count - 1 ? wanted - (count - 1) : 0;
    place.current = wanted - over + rubberband(over * pitch, pitch) / pitch;
    paint();
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    const element = stage.current;
    if (!p || p.id !== event.pointerId) return;
    event.stopPropagation();
    press.current = null;
    const pitch = (element?.clientWidth ?? 0) + APART;
    const home = Math.round(p.from);
    if (p.decided !== true) {
      // A press that never became a swipe, or an interrupted glide, settles where it was going.
      if (Math.abs(place.current - goal.current) > 0.001) glide(goal.current, 0, SETTLE);
      if (p.decided === undefined && event.type === "pointerup" && onTap && element) {
        const box = element.getBoundingClientRect();
        onTap(event.clientX - box.left < box.width / 3 ? -1 : 1);
      }
      return;
    }
    const first = p.moves[0];
    const last = p.moves.at(-1);
    const velocity =
      first && last && last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0;
    const turn =
      event.type === "pointercancel"
        ? 0
        : swipeTurn(event.clientX - p.x, velocity, element?.clientWidth ?? pitch);
    const to = clampPage(home + 1 + turn, count) - 1;
    glide(to, -velocity / pitch, Math.abs(velocity) > FLICK ? MOMENTUM : SETTLE);
    if (to !== slide - 1) onSlide(to + 1);
  };

  const slides = [];
  for (let i = Math.max(0, near[0]); i <= Math.min(count - 1, near[1]); i++) {
    const size = sizes[i];
    if (!size || !box.w) continue;
    const shape = contain(size.w / size.h, box, margin);
    const width = Math.round(shape.w);
    slides.push(
      <div
        key={i}
        data-index={i}
        className="viewer-slide"
        aria-hidden={i !== slide - 1 || undefined}
        style={{
          left: (box.w - width) / 2,
          // A little above the middle, where the eye puts the middle.
          top: (box.h - shape.h) * 0.45,
          width,
          height: shape.h,
        }}
      >
        <PdfPage pdf={pdf} number={i + 1} width={width} />
      </div>,
    );
  }
  return (
    <div
      ref={stage}
      className="viewer-slide-stage"
      role="img"
      aria-label={`Slide ${slide} of ${count}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {slides}
    </div>
  );
}

// The deck filling the screen: the browser's full screen where it has one, the whole window as
// one layer where it has not (an iPhone). A press on the right goes on, on the left back; Esc, or
// leaving full screen, comes out.
function Present({
  pdf,
  sizes,
  slide,
  onSlide,
  onClose,
}: {
  pdf: PDFDocumentProxy;
  sizes: readonly PageSize[];
  slide: number;
  onSlide(slide: number): void;
  onClose(): void;
}) {
  const count = sizes.length;
  const root = useRef<HTMLDivElement>(null);
  const [controls, setControls] = useState(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const slideRef = useRef(slide);
  slideRef.current = slide;
  useLayer({ active: true, root, panel: root, trap: true, modal: true, onEscape: onClose });

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let full = false;
    const onChange = () => {
      if (document.fullscreenElement === element) full = true;
      else if (full) closeRef.current();
    };
    document.addEventListener("fullscreenchange", onChange);
    if (document.fullscreenEnabled && element.requestFullscreen)
      element.requestFullscreen({ navigationUI: "hide" }).then(
        () => {
          const orientation = screen.orientation as ScreenOrientation & {
            lock?(kind: string): Promise<void>;
          };
          if (matches(PHONE)) orientation.lock?.("landscape").catch(() => {});
        },
        () => {},
      );
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const turn = keyTurn(event, "slides");
      if (!turn) return;
      event.preventDefault();
      onSlide(turned(slideRef.current, turn, count));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onSlide, count]);

  // The controls show on arriving and whenever the pointer moves, then fade.
  const timer = useRef(0);
  const wake = useCallback(() => {
    setControls(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setControls(false), CONTROLS_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => window.clearTimeout(timer.current);
  }, [wake]);

  return createPortal(
    <div
      ref={root}
      className="viewer-present"
      role="dialog"
      aria-modal="true"
      aria-label="Presenting"
      tabIndex={-1}
      onPointerMove={(event) => event.pointerType === "mouse" && wake()}
      data-controls={controls || undefined}
    >
      <SlideTrack
        pdf={pdf}
        sizes={sizes}
        slide={slide}
        onSlide={onSlide}
        margin={0}
        onTap={(side) => {
          onSlide(slideRef.current + side);
          wake();
        }}
      />
      <p className="viewer-present-hint">Turn your phone sideways for a bigger slide</p>
      <div className="viewer-present-bar">
        <IconButton
          icon="chevron-left"
          size={36}
          variant="glass"
          round
          label="Previous slide"
          disabledReason={slide <= 1 ? "This is the first slide" : undefined}
          onClick={() => onSlide(slide - 1)}
        />
        <span className="viewer-present-count num">
          {slide} / {count}
        </span>
        <IconButton
          icon="chevron-right"
          size={36}
          variant="glass"
          round
          label="Next slide"
          disabledReason={slide >= count ? "This is the last slide" : undefined}
          onClick={() => onSlide(slide + 1)}
        />
        <span className="viewer-present-rule" aria-hidden="true" />
        <IconButton
          icon="shrink"
          size={36}
          variant="glass"
          round
          label="Stop presenting"
          kbd={["Esc"]}
          onClick={onClose}
        />
      </div>
    </div>,
    document.body,
  );
}
