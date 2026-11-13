import { useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";

// Where the rows a list held begin in it now: the ones added before them are an earlier page.
function heldFrom(held: readonly string[], now: readonly string[]): number {
  const at = new Map(now.map((key, index) => [key, index]));
  for (const key of held) {
    const index = at.get(key);
    if (index !== undefined) return index;
  }
  return 0;
}

// Lists can live in a sheet, rail or page. Observe their actual scroll parent instead of
// introducing a nested scroller. Small lists retain their normal layout and keyboard behavior.
// An anchored list's scroller keeps the reader's place itself (useFollowScroll).
// A row the window draws again as the reader scrolls gets [data-returned], and so does a row of an
// earlier page: both were there before the reader looked, so they and what they hold stand as they
// are, where a row just added arrives.
export function useVirtualRows(
  list: RefObject<HTMLElement | null>,
  keys: readonly string[],
  estimateSize: (index: number) => number,
  { anchored = false }: { anchored?: boolean } = {},
) {
  const enabled = keys.length > 30;
  const [scroll, setScroll] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const [located, setLocated] = useState(false);
  const latest = useRef(keys);
  latest.current = keys;
  // The rows of the last commit, read as this one's attach: effects run after refs.
  const held = useRef<{ keys: readonly string[]; has: ReadonlySet<string> }>({
    keys: [],
    has: new Set(),
  });
  const drawn = useRef(new WeakSet<Element>());
  const earlier = useRef<{ keys: readonly string[]; before: number } | null>(null);
  useLayoutEffect(() => {
    held.current = { keys, has: new Set(keys) };
  }, [keys]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!enabled || !element) return;
    let parent = element.parentElement;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY))
      parent = parent.parentElement;
    setLocated(true);
    if (!parent) return;
    const port = parent;
    setScroll(port);
    const measure = () =>
      setMargin(
        element.getBoundingClientRect().top - port.getBoundingClientRect().top + port.scrollTop,
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(port);
    observer.observe(element);
    // Content preceding the list (for example exported videos) can change its offset.
    if (element.parentElement !== port && element.parentElement)
      observer.observe(element.parentElement);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [list, enabled]);
  const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys]);
  const virtual = useVirtualizer({
    count: keys.length,
    getScrollElement: () => scroll,
    getItemKey,
    estimateSize,
    overscan: 6,
    // Measuring rows can synchronously resize their scrollport. Defer the
    // virtualizer's writes out of ResizeObserver delivery, especially on WebKit.
    useAnimationFrameWithResizeObserver: true,
    scrollMargin: margin,
    enabled: enabled && !!scroll,
    initialOffset: () => scroll?.scrollTop ?? 0,
    initialRect: { width: 400, height: 500 },
  });
  // Correcting for a row measured above the view as well would move it twice, by a scroll its
  // keeper did not make.
  virtual.shouldAdjustScrollPositionOnItemSizeChange = anchored ? () => false : undefined;
  const items = virtual.getVirtualItems();
  const active = enabled && !!scroll;
  const measureElement = virtual.measureElement;
  const measure = useCallback(
    (element: Element | null) => {
      if (element && !drawn.current.has(element)) {
        drawn.current.add(element);
        const now = latest.current,
          index = Number(element.getAttribute("data-index")),
          key = now[index];
        if (earlier.current?.keys !== now)
          earlier.current = { keys: now, before: heldFrom(held.current.keys, now) };
        if (key !== undefined && (held.current.has.has(key) || index < earlier.current.before))
          element.setAttribute("data-returned", "");
      }
      measureElement(element);
    },
    [measureElement],
  );
  // "auto" scrolls only as far as brings the row into view; "start" puts it at the top.
  const scrollTo = useCallback(
    (index: number, align: "auto" | "start" = "auto") => {
      if (enabled) virtual.scrollToIndex(index, { align });
    },
    [enabled, virtual],
  );
  return {
    enabled,
    indexes: active
      ? items.map((item) => item.index)
      : (enabled && !located ? keys.slice(0, 30) : keys).map((_, index) => index),
    before: active && items.length ? Math.max(0, (items[0]?.start ?? margin) - margin) : 0,
    after:
      active && items.length
        ? Math.max(0, virtual.getTotalSize() - ((items.at(-1)?.end ?? margin) - margin))
        : 0,
    measure: active ? measure : undefined,
    scrollTo,
  };
}
