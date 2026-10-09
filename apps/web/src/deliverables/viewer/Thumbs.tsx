import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { matches, REDUCED_MOTION } from "../../ui/media.ts";
import { ThumbnailButton } from "../../ui/Thumbnail.tsx";
import { type PageSize, PdfPage } from "./PdfPage.tsx";
import { nearby, run } from "./paging.ts";

// A rail down the side holds thumbnails 96 px wide, each with its number under it; a strip along
// the bottom holds them at one height, numbered only where there is room.
const RAIL = { across: 96, gap: 16, pad: 20, number: 20 };
const STRIP = { gap: 10, pad: 16 };
// Thumbnails drawn at once, however fast the list is scrolled.
const MOST = 48;
const WAIT_MS = 120;

// The pages as thumbnails along one axis, the current one ringed and kept in view. Only those near
// the visible part are mounted, so a 300-page PDF draws a dozen.
export function Thumbs({
  pdf,
  sizes,
  current,
  axis,
  height = 56,
  numbered = true,
  noun,
  onPick,
}: {
  pdf: PDFDocumentProxy;
  sizes: readonly PageSize[];
  current: number;
  axis: "x" | "y";
  // A strip's thumbnail height.
  height?: number;
  numbered?: boolean;
  noun: "Page" | "Slide";
  onPick(page: number): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ from: 0, size: 0 });
  const lengths = useMemo(
    () =>
      sizes.map((s) =>
        axis === "y"
          ? RAIL.across * (s.h / s.w) + (numbered ? RAIL.number : 0)
          : height * (s.w / s.h),
      ),
    [sizes, axis, height, numbered],
  );
  const laid = useMemo(
    () => (axis === "y" ? run(lengths, RAIL.gap, RAIL.pad) : run(lengths, STRIP.gap, STRIP.pad)),
    [lengths, axis],
  );

  useLayoutEffect(() => {
    const host = scroller.current;
    if (!host) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next =
          axis === "y"
            ? { from: host.scrollTop, size: host.clientHeight }
            : { from: host.scrollLeft, size: host.clientWidth };
        setView((was) => (was.from === next.from && was.size === next.size ? was : next));
      });
    };
    measure();
    host.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [axis]);

  // The current page's thumbnail comes into view the least way, gliding when it is near.
  useEffect(() => {
    const host = scroller.current;
    const start = laid.starts[current - 1];
    const length = laid.lengths[current - 1];
    if (!host || start === undefined || length === undefined) return;
    const from = axis === "y" ? host.scrollTop : host.scrollLeft;
    const size = axis === "y" ? host.clientHeight : host.clientWidth;
    const margin = axis === "y" ? RAIL.pad : STRIP.pad;
    let to = from;
    if (start - margin < from) to = start - margin;
    else if (start + length + margin > from + size) to = start + length + margin - size;
    if (to === from) return;
    // From far away it lands in the middle, with the pages either side of it in view.
    const near = Math.abs(to - from) < size * 2;
    if (!near) to = start + length / 2 - size / 2;
    host.scrollTo({
      [axis === "y" ? "top" : "left"]: to,
      behavior: near && !matches(REDUCED_MOTION) ? "smooth" : "instant",
    });
  }, [current, laid, axis]);

  const [first, last] = nearby(laid, view.from, view.size, view.size, MOST);
  const items = [];
  for (let i = first; i <= last; i++) {
    const size = sizes[i];
    const start = laid.starts[i];
    if (!size || start === undefined) continue;
    const ratio = size.w / size.h;
    const width = axis === "y" ? RAIL.across : height * ratio;
    items.push(
      <div
        key={i}
        className="viewer-thumb"
        style={axis === "y" ? { top: start, width } : { left: start, width }}
      >
        <ThumbnailButton
          label={`${noun} ${i + 1}`}
          ratio={ratio}
          current={current === i + 1}
          onClick={() => onPick(i + 1)}
        >
          <PdfPage pdf={pdf} number={i + 1} width={Math.round(width)} wait={WAIT_MS} />
        </ThumbnailButton>
        {numbered && <span className="viewer-thumb-number num">{i + 1}</span>}
      </div>,
    );
  }
  return (
    <nav ref={scroller} className="viewer-thumbs" data-axis={axis} aria-label={`${noun}s`}>
      <div
        className="viewer-thumbs-run"
        style={
          axis === "y"
            ? { height: laid.total }
            : { width: laid.total, height: height + (numbered ? RAIL.number : 0) }
        }
      >
        {items}
      </div>
    </nav>
  );
}
