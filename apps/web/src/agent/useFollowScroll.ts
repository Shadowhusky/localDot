import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Within this many px of the end, the reader is following the live end.
const PIN_SLACK = 32;

interface Tracking {
  element: HTMLElement | null;
  observer: ResizeObserver | null;
  mutations: MutationObserver | null;
  pinned: boolean;
  anchor: HTMLElement | null;
  anchorTop: number;
  frame: number;
  // A jump scrolls smoothly; until it lands, its own scroll events must not end the following.
  jumping: boolean;
  glide: { frame: number; from: number; start: number; at: number } | null;
  height: number;
}

// Following the end, a new row lifts the list by its height over this long, eased like --ease-enter.
const GLIDE_MS = 360;
const eased = (progress: number) => 1 - (1 - progress) ** 4;

export const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const scrollToEnd = (element: HTMLElement) =>
  element.scrollTo?.({ top: element.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });

// Where a row sits in the view, by layout: a row still easing in (a transform) has not moved.
function topOf(element: HTMLElement, scroller: HTMLElement): number {
  let top = 0;
  for (let node: HTMLElement | null = element; node; ) {
    top += node.offsetTop;
    const parent: Element | null = node.offsetParent;
    node =
      parent instanceof HTMLElement && parent !== scroller && scroller.contains(parent)
        ? parent
        : null;
  }
  return top - scroller.scrollTop;
}

// Following the end, the end stays in view; scrolled back, the first [data-anchor] row in view stays
// put. The browser's own scroll anchoring is off (WebKit has none), so both engines behave alike.
// Without glide the end is held at once, in the same frame as the growth, so nothing at the end
// moves.
export function useFollowScroll(owner: string, follow: boolean, { glide = true } = {}) {
  const glides = useRef(glide);
  glides.current = glide;
  const [pinned, setPinned] = useState(follow);
  const tracking = useRef<Tracking>({
    element: null,
    observer: null,
    mutations: null,
    pinned: follow,
    anchor: null,
    anchorTop: 0,
    frame: 0,
    jumping: false,
    glide: null,
    height: 0,
  });

  const settle = useCallback(() => {
    const t = tracking.current,
      element = t.element;
    if (!element) return;
    t.height = element.scrollHeight;
    if (t.pinned) {
      const end = element.scrollHeight - element.clientHeight;
      const lift = end - element.scrollTop;
      if (lift <= 0.5) return;
      // A jump still on its way was aimed at the old end; aim it at the new one instead.
      if (t.jumping) {
        scrollToEnd(element);
        return;
      }
      // A whole screen or more (a first load, a page) is taken at once; one or two rows glide, from
      // wherever a glide in flight has got to, toward the end as it is when each frame is drawn.
      const starts = glides.current;
      if (lift >= element.clientHeight || reducedMotion() || !(starts || t.glide)) {
        if (t.glide) cancelAnimationFrame(t.glide.frame);
        t.glide = null;
        element.scrollTop = end;
        return;
      }
      // Where growth is held at once, a glide already under way keeps its pace to the end.
      if (!starts) return;
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
        t.anchorTop = topOf(row, element);
        break;
      }
    }
  }, []);

  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      const t = tracking.current;
      t.observer?.disconnect();
      t.observer = null;
      t.mutations?.disconnect();
      t.mutations = null;
      t.element = element;
      if (!element || typeof ResizeObserver === "undefined") return;
      t.observer = new ResizeObserver(settle);
      t.observer.observe(element);
      if (element.firstElementChild) t.observer.observe(element.firstElementChild);
      // Rows and words are held in the task that adds them, before the frame that draws them; a
      // resize is only observed after that frame has been laid out, a frame late.
      if (typeof MutationObserver === "undefined") return;
      t.mutations = new MutationObserver(settle);
      t.mutations.observe(element, { childList: true, subtree: true, characterData: true });
    },
    [settle],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the owner is the trigger.
  useLayoutEffect(() => {
    const t = tracking.current;
    t.anchor = null;
    setPin(follow);
    if (t.element) t.element.scrollTop = follow ? t.element.scrollHeight : 0;
  }, [owner, follow, setPin]);

  // Says whether the reader still follows the live end after this scroll.
  const onScroll = useCallback((): boolean => {
    const t = tracking.current,
      element = t.element;
    if (!element) return t.pinned;
    const below = element.scrollHeight - element.clientHeight - element.scrollTop;
    // Rows that arrived before their resize was observed moved the end, not the reader; a reader who
    // scrolled back further than they grew is reading.
    const unseen = element.scrollHeight - t.height;
    if (t.pinned && t.observer && unseen > 0.5 && below < unseen + PIN_SLACK) {
      settle();
      return true;
    }
    // A scroll the glide did not make (the reader's, or the page's) ends the glide.
    if (t.glide && t.glide.at >= 0 && Math.abs(element.scrollTop - t.glide.at) > 1) {
      cancelAnimationFrame(t.glide.frame);
      t.glide = null;
    }
    if ((t.jumping || t.glide) && below >= PIN_SLACK) return t.pinned;
    if (below <= 1) t.jumping = false;
    const next = follow && below < PIN_SLACK;
    if (next !== t.pinned) setPin(next);
    cancelAnimationFrame(t.frame);
    t.frame = requestAnimationFrame(pickAnchor);
    return next;
  }, [follow, pickAnchor, setPin, settle]);

  return {
    ref,
    pinned,
    onScroll,
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
      scrollToEnd(t.element);
    },
    interrupt() {
      const t = tracking.current;
      t.jumping = false;
      if (t.glide) cancelAnimationFrame(t.glide.frame);
      t.glide = null;
    },
    // Following the end, an element whose top the end would hide is brought to the top of the view,
    // this far below it, and held there instead. Says whether it was.
    reveal(element: HTMLElement, margin = 0): boolean {
      const t = tracking.current,
        view = t.element;
      const content = view?.firstElementChild;
      if (!view || !t.pinned || !(content instanceof HTMLElement)) return false;
      const top = topOf(element, view) - topOf(content, view) - margin;
      if (top >= view.scrollHeight - view.clientHeight - 0.5) return false;
      t.jumping = false;
      if (t.glide) cancelAnimationFrame(t.glide.frame);
      t.glide = null;
      view.scrollTop = top;
      setPin(false);
      t.anchor = element;
      t.anchorTop = topOf(element, view);
      return true;
    },
    // Stops following the end before the reader is moved elsewhere on purpose, such as a page.
    release() {
      const t = tracking.current;
      t.jumping = false;
      if (t.glide) cancelAnimationFrame(t.glide.frame);
      t.glide = null;
      t.anchor = null;
      setPin(false);
    },
    // Read now, not as of the last render.
    following: () => tracking.current.pinned,
  };
}
