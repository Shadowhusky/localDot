import { useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject, useCallback, useLayoutEffect, useState } from "react";

// Lists can live in a sheet, rail or page. Observe their actual scroll parent instead of
// introducing a nested scroller. Small lists retain their normal layout and keyboard behavior.
// An anchored list's scroller keeps the reader's place itself (useFollowScroll).
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
    measure: active ? virtual.measureElement : undefined,
    scrollTo,
  };
}
