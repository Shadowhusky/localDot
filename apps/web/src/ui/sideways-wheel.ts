// A strip that scrolls sideways takes a mouse wheel's up and down as left and right while it can
// still move that way; at its end the wheel scrolls the page again. A trackpad's own sideways swipe,
// and a zoom, are left to the browser. As a ref callback: it returns what undoes it.
export function sidewaysWheel(strip: HTMLElement | null): (() => void) | undefined {
  if (!strip) return undefined;
  const turn = (event: WheelEvent) => {
    if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const room = strip.scrollWidth - strip.clientWidth;
    if (room <= 0) return;
    const step = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    const to = Math.min(room, Math.max(0, strip.scrollLeft + step));
    if (Math.abs(to - strip.scrollLeft) < 0.5) return;
    event.preventDefault();
    strip.scrollLeft = to;
  };
  strip.addEventListener("wheel", turn, { passive: false });
  return () => strip.removeEventListener("wheel", turn);
}
