import { useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject, useCallback, useLayoutEffect, useState } from "react";

// Lists can live in a sheet, rail or page. Observe their actual scroll parent instead of
// introducing a nested scroller. Small lists retain their normal layout and keyboard behavior.
export function useVirtualRows(
  list: RefObject<HTMLElement | null>,
  keys: readonly string[],
  estimateSize: (index: number) => number,
) {
  const enabled = keys.length > 30;
  const [scroll, setScroll] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const element = list.current;
    if (!enabled || !element) return;
    let parent = element.parentElement;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY))
      parent = parent.parentElement;
    if (!parent) return;
    const port = parent;
    setScroll(port);
    const measure = () =>
      setMargin(
        element.getBoundingClientRect().top - port.getBoundingClientRect().top + port.scrollTop,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(port);
    observer.observe(element);
    // Content preceding the list (for example exported videos) can change its offset.
    if (element.parentElement !== port && element.parentElement)
      observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, [list, enabled]);
  const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys]);
  const virtual = useVirtualizer({
    count: keys.length,
    getScrollElement: () => scroll,
    getItemKey,
    estimateSize,
    overscan: 6,
    scrollMargin: margin,
    enabled,
    initialRect: { width: 400, height: 500 },
  });
  const items = virtual.getVirtualItems();
  return {
    enabled,
    indexes: enabled ? items.map((item) => item.index) : keys.map((_, index) => index),
    before: enabled && items.length ? Math.max(0, (items[0]?.start ?? margin) - margin) : 0,
    after:
      enabled && items.length
        ? Math.max(0, virtual.getTotalSize() - ((items.at(-1)?.end ?? margin) - margin))
        : 0,
    measure: enabled ? virtual.measureElement : undefined,
    scrollTo: (index: number) => {
      if (enabled) virtual.scrollToIndex(index, { align: "auto" });
    },
  };
}
