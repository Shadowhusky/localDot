import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconButton } from "../../ui/IconButton.tsx";
import { matches, PHONE, REDUCED_MOTION, useMediaQuery } from "../../ui/media.ts";
import { SegmentedControl } from "../../ui/SegmentedControl.tsx";
import { PageCounter } from "./PageCounter.tsx";
import { type PageSize, PdfPage } from "./PdfPage.tsx";
import {
  clampPage,
  fittedWidth,
  indexAt,
  keyTurn,
  nearby,
  readingPage,
  run,
  turned,
  zoomStep,
} from "./paging.ts";
import { ViewerBar } from "./states.tsx";
import { Thumbs } from "./Thumbs.tsx";
import { viewerHears } from "./viewer-keys.ts";
import { rubberband, swipeTurn } from "./zoom.ts";

const GAP = 16;
// Pages drawn at once, wherever the document is scrolled to.
const MOST = 8;
// A page's printed width at 100%: points at 96 px to the inch.
const PX_PER_POINT = 96 / 72;
// Room left above a page that is gone to, so its top edge shows.
const AIR = 12;

type Zoom = { fit: "width" | "page" } | { scale: number };

// A document's pages in one column, drawn only near the view, so a 300-page PDF opens at once and
// holds a few pages in memory. The counter, the arrows, Page Up and Down and the thumbnails move
// between pages; on a phone a sideways swipe turns the page and the controls sit at the bottom.
export function PagesView({
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
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [column, setColumn] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<Zoom>({ fit: "width" });
  const [shown, setShown] = useState<{ range: [number, number]; page: number }>({
    range: [0, -1],
    page: 1,
  });
  const [strip, setStrip] = useState(false);
  const margin = phone ? 12 : 32;
  const reference = sizes[0] ?? { w: 612, h: 792 };
  const printed = reference.w * PX_PER_POINT;
  const width =
    column.w === 0
      ? 0
      : "fit" in zoom
        ? Math.round(fittedWidth(zoom.fit, column, reference.w / reference.h, margin))
        : Math.round(zoom.scale * printed);
  const scale = width / printed;
  const laid = useMemo(
    () =>
      run(
        sizes.map((s) => (width * s.h) / s.w),
        GAP,
        margin,
      ),
    [sizes, width, margin],
  );
  const laidRef = useRef(laid);
  laidRef.current = laid;
  // Where the view is, as a page and how far into it, so a zoom or a resize keeps the same place.
  const anchor = useRef<{ index: number; into: number } | null>(null);
  // A page gone to stays the page on show until the reader scrolls themselves.
  const pinned = useRef<number | null>(null);
  const centredAt = useRef(0);

  const look = useCallback(() => {
    const host = scroller.current;
    const r = laidRef.current;
    // Nothing is placed before the column has been measured.
    if (!host || !r.starts.length || !r.lengths[0]) return;
    const top = host.scrollTop;
    const index = indexAt(r, top);
    anchor.current = {
      index,
      into: (top - (r.starts[index] ?? 0)) / Math.max(1, r.lengths[index] ?? 1),
    };
    const range = nearby(r, top, host.clientHeight, host.clientHeight, MOST);
    const page = pinned.current ?? readingPage(r, top, host.clientHeight);
    setShown((was) =>
      was.page === page && was.range[0] === range[0] && was.range[1] === range[1]
        ? was
        : { range, page },
    );
  }, []);

  useLayoutEffect(() => {
    const host = scroller.current;
    if (!host) return;
    let frame = 0;
    const measure = () => {
      setColumn((was) =>
        was.w === host.clientWidth && was.h === host.clientHeight
          ? was
          : { w: host.clientWidth, h: host.clientHeight },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
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

  // The same page and place stay in view whenever the pages change size.
  useLayoutEffect(() => {
    const host = scroller.current;
    if (!host || !laid.starts.length || !laid.lengths[0]) return;
    if (anchor.current) {
      const { index, into } = anchor.current;
      const top = (laid.starts[index] ?? 0) + into * (laid.lengths[index] ?? 0);
      if (Math.abs(host.scrollTop - top) > 1) host.scrollTop = top;
    }
    if (centredAt.current !== width) {
      centredAt.current = width;
      host.scrollLeft = (host.scrollWidth - host.clientWidth) / 2;
    }
    look();
  }, [laid, width, look]);

  useEffect(() => {
    const host = scroller.current;
    if (!host) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(look);
    };
    const own = () => {
      pinned.current = null;
    };
    host.addEventListener("scroll", onScroll, { passive: true });
    for (const type of ["wheel", "touchstart", "pointerdown"])
      host.addEventListener(type, own, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener("scroll", onScroll);
      for (const type of ["wheel", "touchstart", "pointerdown"])
        host.removeEventListener(type, own);
    };
  }, [look]);

  const go = useCallback((wanted: number) => {
    const host = scroller.current;
    const r = laidRef.current;
    const page = clampPage(wanted, r.starts.length);
    const start = r.starts[page - 1];
    if (!host || start === undefined) return;
    const top = Math.max(0, start - AIR);
    const near = Math.abs(host.scrollTop - top) < host.clientHeight * 2.5;
    pinned.current = page;
    setShown((was) => ({ ...was, page }));
    host.scrollTo({ top, behavior: near && !matches(REDUCED_MOTION) ? "smooth" : "instant" });
  }, []);
  const pageRef = useRef(shown.page);
  pageRef.current = shown.page;

  // Page Up and Down, the side arrows, Home and End turn pages; up and down and the space bar
  // scroll, also before the pages have focus. On a page zoomed wider than the column the side
  // arrows scroll it across instead.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const host = scroller.current;
      if (event.defaultPrevented || !host || !viewerHears(host, event)) return;
      const turn = keyTurn(event, "pages");
      const across = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      const wide = turn !== undefined && across !== 0 && host.scrollWidth > host.clientWidth + 1;
      if (turn && !wide) {
        event.preventDefault();
        go(turned(pageRef.current, turn, count));
        return;
      }
      const inside = event.target instanceof Node && host.contains(event.target);
      if ((inside && !wide) || event.altKey || event.ctrlKey || event.metaKey) return;
      const step = wide
        ? { left: across * 48 }
        : event.key === "ArrowDown"
          ? { top: 48 }
          : event.key === "ArrowUp"
            ? { top: -48 }
            : event.key === " "
              ? { top: host.clientHeight * (event.shiftKey ? -0.9 : 0.9) }
              : undefined;
      if (!step) return;
      event.preventDefault();
      pinned.current = null;
      host.scrollBy({ ...step, behavior: matches(REDUCED_MOTION) ? "instant" : "smooth" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, count]);

  // A pinch on the trackpad zooms.
  useEffect(() => {
    const host = scroller.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const next = Math.min(4, Math.max(0.25, scale * Math.exp(-event.deltaY * 0.01)));
      setZoom({ scale: next });
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [scale]);

  // On a phone a sideways swipe turns the page: the column follows the finger, giving less and less,
  // and springs back as the next page comes up.
  const swipe = useRef<{
    id: number;
    x: number;
    y: number;
    decided?: boolean;
    moves: { t: number; x: number }[];
  } | null>(null);
  const shift = (dx: number | null) => {
    const element = content.current;
    if (!element) return;
    element.toggleAttribute("data-dragging", dx !== null);
    element.style.transform = dx ? `translate3d(${dx}px, 0, 0)` : "";
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || swipe.current) return;
    event.stopPropagation();
    swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moves: [] };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    const host = scroller.current;
    if (!s || s.id !== event.pointerId || !host) return;
    event.stopPropagation();
    const dx = event.clientX - s.x;
    const dy = event.clientY - s.y;
    if (!s.decided) {
      if (Math.hypot(dx, dy) < 10) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5 || host.scrollWidth > host.clientWidth + 1) {
        swipe.current = null;
        return;
      }
      s.decided = true;
      host.setPointerCapture(event.pointerId);
    }
    s.moves = [...s.moves.slice(-5), { t: event.timeStamp, x: event.clientX }];
    shift(rubberband(dx, host.clientWidth, 0.35));
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!s || s.id !== event.pointerId) return;
    event.stopPropagation();
    swipe.current = null;
    if (!s.decided) return;
    const first = s.moves[0];
    const last = s.moves.at(-1);
    const velocity =
      first && last && last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0;
    const turn =
      event.type === "pointercancel"
        ? 0
        : swipeTurn(event.clientX - s.x, velocity, scroller.current?.clientWidth ?? 390);
    shift(null);
    if (turn !== 0) go(pageRef.current + turn);
  };

  const fit = "fit" in zoom ? zoom.fit : "";
  const zoomIn = zoomStep(scale, 1);
  const zoomOut = zoomStep(scale, -1);
  const counter = <PageCounter page={shown.page} count={count} noun="Page" onGo={go} />;
  const contentWidth = Math.max(column.w, width + margin * 2);
  const pages = [];
  for (let i = shown.range[0]; i <= shown.range[1]; i++) {
    const top = laid.starts[i];
    const height = laid.lengths[i];
    if (top === undefined || height === undefined || width === 0) continue;
    pages.push(
      <div
        key={i}
        className="viewer-paper"
        data-page={i + 1}
        style={{ top, left: (contentWidth - width) / 2, width, height }}
      >
        <PdfPage pdf={pdf} number={i + 1} width={width} text />
      </div>,
    );
  }
  return (
    <>
      {(!phone || lead) && (
        <ViewerBar
          end={
            !phone && (
              <>
                <SegmentedControl
                  size={28}
                  aria-label="Fit"
                  value={fit}
                  items={[
                    { value: "width", label: "Fit width" },
                    { value: "page", label: "Fit page" },
                  ]}
                  onValueChange={(value) => setZoom({ fit: value === "page" ? "page" : "width" })}
                />
                <div className="viewer-zoom">
                  <IconButton
                    icon="minus"
                    size={28}
                    label="Zoom out"
                    disabledReason={zoomOut === undefined ? "Zoomed out all the way" : undefined}
                    onClick={() => zoomOut !== undefined && setZoom({ scale: zoomOut })}
                  />
                  <span className="viewer-zoom-value num">{Math.round(scale * 100)}%</span>
                  <IconButton
                    icon="plus"
                    size={28}
                    label="Zoom in"
                    disabledReason={zoomIn === undefined ? "Zoomed in all the way" : undefined}
                    onClick={() => zoomIn !== undefined && setZoom({ scale: zoomIn })}
                  />
                </div>
              </>
            )
          }
        >
          {lead}
          {!phone && counter}
        </ViewerBar>
      )}
      <div className="viewer-stage viewer-pdf">
        {!phone && count > 1 && (
          <Thumbs pdf={pdf} sizes={sizes} current={shown.page} axis="y" noun="Page" onPick={go} />
        )}
        <div
          ref={scroller}
          className="viewer-pages"
          tabIndex={-1}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <div
            ref={content}
            className="viewer-pages-run"
            style={{ height: laid.total, width: contentWidth }}
          >
            {pages}
          </div>
        </div>
      </div>
      {phone && strip && count > 1 && (
        <Thumbs
          pdf={pdf}
          sizes={sizes}
          current={shown.page}
          axis="x"
          height={72}
          noun="Page"
          onPick={go}
        />
      )}
      {phone && (
        <div className="viewer-pager-bar">
          {counter}
          <div className="viewer-pager-tools">
            <IconButton
              icon={"fit" in zoom ? "zoom-in" : "zoom-out"}
              size={36}
              label={"fit" in zoom ? "Zoom in" : "Fit width"}
              onClick={() =>
                setZoom("fit" in zoom ? { scale: Math.min(4, scale * 2) } : { fit: "width" })
              }
            />
            {count > 1 && (
              <IconButton
                icon="layout-grid"
                size={36}
                label={strip ? "Hide pages" : "Show pages"}
                aria-pressed={strip}
                onClick={() => setStrip((was) => !was)}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
