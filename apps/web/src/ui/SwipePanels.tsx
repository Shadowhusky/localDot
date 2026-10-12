import { type ReactNode, useLayoutEffect, useRef } from "react";

// Native scroll snapping keeps the page attached to the finger and lets the browser arbitrate
// horizontal paging against each panel's vertical scroll. Tab buttons remain available.
export function SwipePanels({
  enabled,
  value,
  values,
  onValueChange,
  children,
}: {
  enabled: boolean;
  value: string;
  values: readonly string[];
  onValueChange(value: string): void;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const latest = useRef({ value, values, onValueChange });
  latest.current = { value, values, onValueChange };
  const fromSwipe = useRef(false);
  const initialized = useRef(false);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!enabled || !element) return;
    const align = (smooth: boolean) => {
      const index = latest.current.values.indexOf(latest.current.value);
      element.scrollTo({
        left: Math.max(0, index) * element.clientWidth,
        behavior:
          smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant",
      });
    };
    align(false);
    initialized.current = true;
    const observer = new ResizeObserver(() => align(false));
    observer.observe(element);
    let timer = 0;
    const settled = () => {
      clearTimeout(timer);
      const index = Math.round(element.scrollLeft / Math.max(1, element.clientWidth));
      const next = latest.current.values[index];
      if (next && next !== latest.current.value) {
        fromSwipe.current = true;
        latest.current.onValueChange(next);
      }
    };
    const scroll = () => {
      clearTimeout(timer);
      timer = window.setTimeout(settled, 120);
    };
    element.addEventListener("scroll", scroll, { passive: true });
    element.addEventListener("scrollend", settled);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      element.removeEventListener("scroll", scroll);
      element.removeEventListener("scrollend", settled);
      initialized.current = false;
    };
  }, [enabled]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!enabled || !element) return;
    if (fromSwipe.current) {
      fromSwipe.current = false;
      return;
    }
    element.scrollTo({
      left: Math.max(0, values.indexOf(value)) * element.clientWidth,
      behavior:
        initialized.current && !matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "smooth"
          : "instant",
    });
  }, [enabled, value, values]);
  return (
    <div ref={viewport} className="ui-swipe-panels" data-swipe={enabled || undefined}>
      {children}
    </div>
  );
}
