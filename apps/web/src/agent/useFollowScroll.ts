import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Within this many px of the end, the reader is following the live end.
const PIN_SLACK = 32;

interface Tracking {
  element: HTMLElement | null;
  observer: ResizeObserver | null;
  pinned: boolean;
  anchor: HTMLElement | null;
  anchorTop: number;
  frame: number;
  // A jump scrolls smoothly; until it lands, its own scroll events must not end the following.
  jumping: boolean;
  glide: { frame: number; from: number; start: number; at: number } | null;
}

// Following the end, a new row lifts the list by its height over this long, eased like --ease-enter.
const GLIDE_MS = 360;
const eased = (progress: number) => 1 - (1 - progress) ** 4;

export const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const topOf = (element: HTMLElement, scroller: HTMLElement) =>
  element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

// Keeps what the reader looks at still while the list changes size. Following the end, the end stays
// in view; scrolled back, the first row in view stays put. The browser's own scroll anchoring is off
// (WebKit has none), so both engines behave alike. Rows that can anchor carry data-anchor.
export function useFollowScroll(owner: string, follow: boolean) {
  const [pinned, setPinned] = useState(follow);
  const tracking = useRef<Tracking>({
    element: null,
    observer: null,
    pinned: follow,
    anchor: null,
    anchorTop: 0,
    frame: 0,
    jumping: false,
    glide: null,
  });

  const settle = useCallback(() => {
    const t = tracking.current,
      element = t.element;
    if (!element) return;
    if (t.pinned) {
      const end = element.scrollHeight - element.clientHeight;
      const lift = end - element.scrollTop;
      if (lift <= 0.5) return;
      // A whole screen or more (a first load, a page) is taken at once; one or two rows glide, from
      // wherever a glide in flight has got to, toward the end as it is when each frame is drawn.
      if (lift >= element.clientHeight || reducedMotion()) {
        if (t.glide) cancelAnimationFrame(t.glide.frame);
        t.glide = null;
        element.scrollTop = end;
        return;
      }
      if (t.glide) cancelAnimationFrame(t.glide.frame);
      const glide = { frame: 0, from: element.scrollTop, start: performance.now(), at: -1 };
      const step = (now: number) => {
        const progress = Math.min(1, (now - glide.start) / GLIDE_MS);
        const target = element.scrollHeight - element.clientHeight;
        element.scrollTop = glide.from + (target - glide.from) * eased(progress);
        glide.at = element.scrollTop;
        if (progress < 1 && t.glide === glide) glide.frame = requestAnimationFrame(step);
        else if (t.glide === glide) t.glide = null;
      };
      t.glide = glide;
      glide.frame = requestAnimationFrame(step);
      return;
    }
    if (!t.anchor?.isConnected) return;
    const delta = topOf(t.anchor, element) - t.anchorTop;
    if (Math.abs(delta) >= 0.5) element.scrollTop += delta;
    t.anchorTop = topOf(t.anchor, element);
  }, []);

  const setPin = useCallback((next: boolean) => {
    tracking.current.pinned = next;
    setPinned(next);
  }, []);

  const pickAnchor = useCallback(() => {
    const t = tracking.current,
      element = t.element;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    t.anchor = null;
    for (const row of element.querySelectorAll<HTMLElement>("[data-anchor]")) {
      if (row.getBoundingClientRect().bottom > top) {
        t.anchor = row;
        t.anchorTop = row.getBoundingClientRect().top - top;
        break;
      }
    }
  }, []);

  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      const t = tracking.current;
      t.observer?.disconnect();
      t.observer = null;
      t.element = element;
      if (!element || typeof ResizeObserver === "undefined") return;
      t.observer = new ResizeObserver(settle);
      t.observer.observe(element);
      if (element.firstElementChild) t.observer.observe(element.firstElementChild);
    },
    [settle],
  );

  // A new owner (task, filter) starts at its live end when following, else at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the owner is the trigger.
  useLayoutEffect(() => {
    const t = tracking.current;
    t.anchor = null;
    setPin(follow);
    if (t.element) t.element.scrollTop = follow ? t.element.scrollHeight : 0;
  }, [owner, follow, setPin]);

  const onScroll = useCallback(() => {
    const t = tracking.current,
      element = t.element;
    if (!element) return;
    const below = element.scrollHeight - element.clientHeight - element.scrollTop;
    // A scroll the glide did not make (the reader's, or the page's) ends the glide.
    if (t.glide && t.glide.at >= 0 && Math.abs(element.scrollTop - t.glide.at) > 1) {
      cancelAnimationFrame(t.glide.frame);
      t.glide = null;
    }
    if ((t.jumping || t.glide) && below >= PIN_SLACK) return;
    t.jumping = false;
    const next = follow && below < PIN_SLACK;
    if (next !== t.pinned) setPin(next);
    cancelAnimationFrame(t.frame);
    t.frame = requestAnimationFrame(pickAnchor);
  }, [follow, pickAnchor, setPin]);

  return {
    ref,
    pinned,
    onScroll,
    // A row the reader just toggled stays where it is while its content opens or closes below it.
    anchorTo(element: HTMLElement) {
      const t = tracking.current;
      if (!t.element) return;
      if (t.glide) cancelAnimationFrame(t.glide.frame);
      t.glide = null;
      setPin(false);
      t.anchor = element;
      t.anchorTop = topOf(element, t.element);
    },
    jump() {
      const t = tracking.current;
      if (!t.element) return;
      setPin(true);
      t.jumping = true;
      t.element.scrollTo?.({
        top: t.element.scrollHeight,
        behavior: reducedMotion() ? "auto" : "smooth",
      });
    },
    // The reader's own wheel, touch or press takes over from a jump still on its way.
    interrupt() {
      const t = tracking.current;
      t.jumping = false;
      if (t.glide) cancelAnimationFrame(t.glide.frame);
      t.glide = null;
    },
  };
}
