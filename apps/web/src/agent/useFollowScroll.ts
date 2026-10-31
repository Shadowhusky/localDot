import {
  type KeyboardEvent,
  type PointerEvent,
  type TouchEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";

// A gesture toward the end that comes to rest this close to it follows the end again...
const END_SLACK = 24;
// ...or further by as much as arrived meanwhile, up to this: rows that arrive during the gesture
// move the end, not the reader.
const ARRIVING_SLACK = 136;
// A gesture's scrolling can go on this long after its last event or scroll: a wheel's or a key's
// smooth scroll, a flick's momentum.
const TAIL_MS = 300;
// A finger that moved this far toward the end swiped there, even with nothing left to scroll.
const SWIPE = 10;
// A jump to the end takes this long, eased like --ease-enter, toward the end as each frame finds it.
const JUMP_MS = 360;
// An element unfolding into view is followed at most this long, however long it keeps growing.
const SHOW_MS = 1500;
const eased = (progress: number) => 1 - (1 - progress) ** 4;

// The keys that scroll a list holding the focus, and which way.
const SCROLL_KEYS: Readonly<Record<string, "up" | "down">> = {
  ArrowUp: "up",
  PageUp: "up",
  Home: "up",
  ArrowDown: "down",
  PageDown: "down",
  End: "down",
};

interface Gesture {
  // Its scrolling may still arrive until then; a press holds it open.
  until: number;
  // How tall the content was as it began.
  height: number;
  // Whether it last moved toward the end.
  down: boolean;
}

interface Tracking {
  element: HTMLElement | null;
  observer: ResizeObserver | null;
  mutations: MutationObserver | null;
  pinned: boolean;
  anchor: HTMLElement | null;
  // Where the anchor sits in the content: scrolling never moves it, only what changes above it.
  anchorAt: number;
  frame: number;
  // Where the view was when the hook last put it there or saw it scrolled: a scroll that finds it
  // anywhere else was not the hook's own.
  top: number;
  jump: { frame: number; from: number; start: number } | null;
  gesture: Gesture | null;
  // A finger or a button is down on the list, or a flick it let go of still coasts: the end is not
  // held under it, so what it is about to press stays where it is.
  pressed: boolean;
  coast: number;
  touchY: number;
  unlisten: (() => void) | null;
}

export const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const below = (element: HTMLElement) =>
  element.scrollHeight - element.clientHeight - element.scrollTop;

// Where a row sits in the content, by layout: a row still easing in (a transform) has not moved.
function offsetIn(element: HTMLElement, scroller: HTMLElement): number {
  let top = 0;
  for (let node: HTMLElement | null = element; node; ) {
    top += node.offsetTop;
    const parent: Element | null = node.offsetParent;
    node =
      parent instanceof HTMLElement && parent !== scroller && scroller.contains(parent)
        ? parent
        : null;
  }
  return top;
}

const topOf = (element: HTMLElement, scroller: HTMLElement) =>
  offsetIn(element, scroller) - scroller.scrollTop;

// How far down the view must go for the end of `box` to sit `bottom` px inside its bottom, but no
// further than keeps its top `top` px inside the view's top. Zero or less: nothing to bring in.
function hiddenBelow(box: DOMRect, view: HTMLElement, top: number, bottom: number): number {
  const edge = view.getBoundingClientRect().top;
  return Math.min(box.bottom + bottom - edge - view.clientHeight, box.top - top - edge);
}

// Within reach of the end; what arrived since the gesture began moved the end, not the reader.
const near = (element: HTMLElement, gesture: Gesture) =>
  below(element) <=
  END_SLACK + Math.min(ARRIVING_SLACK, Math.max(0, element.scrollHeight - gesture.height));

// Keys pressed in a field type, and Space on a control presses it: neither scrolls the list.
function scrolls(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable || target.closest("input, textarea, select")) return false;
  return event.key !== " " || !target.closest("button, a[href], summary, [role=button]");
}

// Following the end, the end stays in view, held in the same frame as anything arrives, so nothing
// at the end moves; scrolled back, the first [data-anchor] row in view stays put. The browser's own
// scroll anchoring is off (WebKit has none), so both engines behave alike. Only the reader leaves
// the end, by scrolling back, and only the reader comes back to it: by a gesture toward the end that
// comes to rest there, or by a jump. The list's own scrolls, and anyone else's, never bring it back.
export function useFollowScroll(owner: string, follow: boolean) {
  const [pinned, setPinned] = useState(follow);
  const tracking = useRef<Tracking>({
    element: null,
    observer: null,
    mutations: null,
    pinned: follow,
    anchor: null,
    anchorAt: 0,
    frame: 0,
    top: 0,
    jump: null,
    gesture: null,
    pressed: false,
    coast: 0,
    touchY: 0,
    unlisten: null,
  });
  const follows = useRef(follow);
  follows.current = follow;

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
        t.anchorAt = offsetIn(row, element);
        break;
      }
    }
  }, []);

  // The hook's own scrolls: their scroll events find the view where it was put.
  const put = useCallback((top: number) => {
    const t = tracking.current;
    if (!t.element) return;
    t.element.scrollTop = top;
    t.top = t.element.scrollTop;
  }, []);

  const stopJump = useCallback(() => {
    const t = tracking.current;
    if (t.jump) cancelAnimationFrame(t.jump.frame);
    t.jump = null;
  }, []);

  // The reader moved back from the end: from now on what is in view stays put. Called before the
  // scroll it announces where it can be (a wheel, a key), as a resize can arrive in the same frame
  // and would otherwise pull the list back down under the reader's gesture.
  const leave = useCallback(() => {
    stopJump();
    if (!tracking.current.pinned) return;
    setPin(false);
    pickAnchor();
  }, [stopJump, setPin, pickAnchor]);

  const hold = useCallback(() => {
    const t = tracking.current,
      element = t.element;
    if (!element) return;
    // Moved up before its scroll event (a control brought into view as it takes the focus): not the
    // hook, so the end is no longer held, or the move would be undone under the reader's press. A
    // view only clamped by shorter content is still at the end.
    if (t.pinned && element.scrollTop < t.top - 1) {
      if (below(element) > 1) leave();
      else t.top = element.scrollTop;
    }
    if (t.jump) return;
    if (t.pinned && !t.pressed) {
      const end = element.scrollHeight - element.clientHeight;
      if (end - element.scrollTop > 0.5) put(end);
      return;
    }
    if (!t.anchor?.isConnected) return;
    const at = offsetIn(t.anchor, element);
    if (Math.abs(at - t.anchorAt) >= 0.5) put(element.scrollTop + at - t.anchorAt);
    t.anchorAt = at;
  }, [leave, put]);

  // A gesture toward the end came to rest at it.
  const stick = useCallback(() => {
    if (!follows.current) return;
    setPin(true);
    hold();
  }, [setPin, hold]);

  // Wheels and keys toward the end continue the gesture their scrolling belongs to; a press starts
  // one of its own.
  const begin = useCallback((down: boolean, fresh: boolean) => {
    const t = tracking.current,
      element = t.element;
    if (!element) return null;
    const now = performance.now();
    if (fresh || !t.gesture || (!t.pressed && now > t.gesture.until))
      t.gesture = { until: now, height: element.scrollHeight, down };
    t.gesture.until = now + TAIL_MS;
    t.gesture.down ||= down;
    return t.gesture;
  }, []);

  // A wheel or a key toward the end follows it again at once when the end is already in view,
  // where there is nothing left to scroll.
  const toward = useCallback(() => {
    const t = tracking.current,
      element = t.element,
      gesture = begin(true, false);
    if (element && gesture && !t.pinned && near(element, gesture)) stick();
  }, [begin, stick]);

  const rest = useCallback(() => {
    const t = tracking.current;
    clearTimeout(t.coast);
    t.coast = 0;
    t.unlisten?.();
    t.unlisten = null;
    t.pressed = false;
    hold();
  }, [hold]);

  // The list may coast on after the finger lifts; the end is held again once it comes to rest.
  const coast = useCallback(() => {
    const t = tracking.current;
    clearTimeout(t.coast);
    t.coast = window.setTimeout(rest, TAIL_MS);
  }, [rest]);

  // A finger or a button comes down on the list: a jump stops where it is, and what is under the
  // press stays there until it lets go.
  const press = useCallback(() => {
    const t = tracking.current;
    if (t.jump) leave();
    clearTimeout(t.coast);
    t.coast = 0;
    t.pressed = true;
    begin(false, true);
    pickAnchor();
  }, [leave, begin, pickAnchor]);

  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      const t = tracking.current;
      t.observer?.disconnect();
      t.observer = null;
      t.mutations?.disconnect();
      t.mutations = null;
      if (!element) {
        stopJump();
        cancelAnimationFrame(t.frame);
        clearTimeout(t.coast);
        t.coast = 0;
        t.unlisten?.();
        t.unlisten = null;
        t.pressed = false;
      }
      t.element = element;
      if (!element || typeof ResizeObserver === "undefined") return;
      t.observer = new ResizeObserver(hold);
      t.observer.observe(element);
      if (element.firstElementChild) t.observer.observe(element.firstElementChild);
      // Rows and words are held in the task that adds them, before the frame that draws them; a
      // resize is only observed after that frame has been laid out, a frame late.
      if (typeof MutationObserver === "undefined") return;
      t.mutations = new MutationObserver(hold);
      t.mutations.observe(element, { childList: true, subtree: true, characterData: true });
    },
    [hold, stopJump],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the owner is the trigger.
  useLayoutEffect(() => {
    const t = tracking.current;
    stopJump();
    t.anchor = null;
    t.gesture = null;
    setPin(follow);
    if (t.element) put(follow ? t.element.scrollHeight : 0);
  }, [owner, follow, setPin, put, stopJump]);

  // Says whether the reader still follows the live end after this scroll.
  const onScroll = useCallback((): boolean => {
    const t = tracking.current,
      element = t.element;
    if (!element) return t.pinned;
    const moved = element.scrollTop - t.top;
    t.top = element.scrollTop;
    const now = performance.now();
    // The reader's gesture, while its scrolling goes on.
    const gesture = t.gesture && (t.pressed || now <= t.gesture.until) ? t.gesture : null;
    if (gesture) {
      gesture.until = now + TAIL_MS;
      if (Math.abs(moved) > 0.5) gesture.down = moved > 0;
    }
    if (t.coast) coast();
    // Back up, and neither the hook's own scroll nor a view clamped by shorter content: reading.
    if (moved < -1 && below(element) > 1) leave();
    else if (gesture?.down && !t.pinned && near(element, gesture)) stick();
    cancelAnimationFrame(t.frame);
    t.frame = requestAnimationFrame(pickAnchor);
    return t.pinned;
  }, [coast, leave, stick, pickAnchor]);

  return {
    ref,
    pinned,
    onScroll,
    // The reader's input on the list, for its scroller. `then` runs as the reader takes hold of it,
    // for what the list itself does about that.
    gestures(then?: () => void) {
      return {
        onWheel(event: WheelEvent) {
          then?.();
          // A pinch zooms, and a sideways wheel moves nothing here.
          if (event.ctrlKey || !event.deltaY) return;
          if (event.deltaY < 0) leave();
          else toward();
        },
        onKeyDown(event: KeyboardEvent) {
          then?.();
          if (event.defaultPrevented || !scrolls(event)) return;
          const way = event.key === " " ? (event.shiftKey ? "up" : "down") : SCROLL_KEYS[event.key];
          if (way === "up") leave();
          else if (way === "down") toward();
        },
        onTouchStart(event: TouchEvent) {
          then?.();
          press();
          tracking.current.touchY = event.touches[0]?.clientY ?? 0;
        },
        onTouchEnd(event: TouchEvent) {
          if (event.touches.length) return;
          const t = tracking.current,
            element = t.element,
            y = event.changedTouches[0]?.clientY;
          // A swipe toward an end already in view has nothing to scroll, yet goes there.
          const swiped = y !== undefined && t.touchY - y > SWIPE;
          if (element && t.gesture && swiped && !t.pinned && near(element, t.gesture)) stick();
          coast();
        },
        onTouchCancel: coast,
        // A finger is followed by its touch events.
        onPointerDown(event: PointerEvent) {
          if (event.pointerType === "touch" || event.button !== 0) return;
          then?.();
          press();
          const id = event.pointerId;
          const lift = (up: globalThis.PointerEvent) => {
            if (up.pointerId === id) rest();
          };
          const t = tracking.current;
          t.unlisten?.();
          window.addEventListener("pointerup", lift);
          window.addEventListener("pointercancel", lift);
          t.unlisten = () => {
            window.removeEventListener("pointerup", lift);
            window.removeEventListener("pointercancel", lift);
          };
        },
      };
    },
    anchorTo(element: HTMLElement, margin?: number) {
      const t = tracking.current,
        view = t.element;
      if (!view) return;
      cancelAnimationFrame(t.frame);
      stopJump();
      if (margin !== undefined) {
        const delta = topOf(element, view) - margin;
        if (delta < 0) put(view.scrollTop + delta);
      }
      setPin(false);
      t.anchor = element;
      t.anchorAt = offsetIn(element, view);
    },
    // Goes to the end and follows it: Jump to latest, or a message just sent.
    jump() {
      const t = tracking.current,
        element = t.element;
      if (!element) return;
      setPin(true);
      stopJump();
      clearTimeout(t.coast);
      t.coast = 0;
      t.pressed = false;
      if (reducedMotion()) {
        put(element.scrollHeight);
        return;
      }
      const jump = { frame: 0, from: element.scrollTop, start: performance.now() };
      const step = () => {
        if (t.jump !== jump) return;
        const progress = Math.min(1, (performance.now() - jump.start) / JUMP_MS);
        const end = element.scrollHeight - element.clientHeight;
        put(jump.from + (end - jump.from) * eased(progress));
        if (progress < 1) jump.frame = requestAnimationFrame(step);
        else t.jump = null;
      };
      t.jump = jump;
      jump.frame = requestAnimationFrame(step);
    },
    // Following the end, an element whose top the end would hide is brought to the top of the view,
    // this far below it, and held there instead. Says whether it was.
    reveal(element: HTMLElement, margin = 0): boolean {
      const t = tracking.current,
        view = t.element;
      const content = view?.firstElementChild;
      if (!view || !t.pinned || !(content instanceof HTMLElement)) return false;
      const top = offsetIn(element, view) - offsetIn(content, view) - margin;
      if (top >= view.scrollHeight - view.clientHeight - 0.5) return false;
      stopJump();
      put(top);
      setPin(false);
      t.anchor = element;
      t.anchorAt = offsetIn(element, view);
      return true;
    },
    // An element the reader has just unfolded is followed down into view as it unfolds, until its
    // end sits `bottom` px inside the view's bottom, or its top `margin` px inside the view's top
    // when there is no room for both. The view only moves down, and only as far as that takes;
    // eased like a jump, and stopped like one by the reader taking hold of the list. It is held
    // there after.
    show(element: HTMLElement, margin = 0, bottom = margin) {
      const t = tracking.current,
        view = t.element;
      if (!view) return;
      stopJump();
      setPin(false);
      const glide = { frame: 0, from: view.scrollTop, start: performance.now() };
      let height = Number.NaN;
      let still = 0;
      const step = () => {
        if (t.jump !== glide) return;
        const box = element.getBoundingClientRect();
        const hidden = hiddenBelow(box, view, margin, bottom);
        const elapsed = performance.now() - glide.start;
        const progress = reducedMotion() ? 1 : Math.min(1, elapsed / JUMP_MS);
        if (hidden > 0) {
          const goal = view.scrollTop + hidden;
          put(Math.max(view.scrollTop, glide.from + (goal - glide.from) * eased(progress)));
        }
        // Done once it has stopped unfolding.
        still = Math.abs(box.height - height) < 0.5 ? still + 1 : 0;
        height = box.height;
        if ((progress < 1 || still < 2) && elapsed < SHOW_MS) {
          glide.frame = requestAnimationFrame(step);
          return;
        }
        t.jump = null;
        t.anchor = element;
        t.anchorAt = offsetIn(element, view);
      };
      t.jump = glide;
      glide.frame = requestAnimationFrame(step);
    },
    // Stops following the end before the reader is moved elsewhere on purpose, such as a page.
    release() {
      const t = tracking.current;
      stopJump();
      t.anchor = null;
      setPin(false);
    },
    // Read now, not as of the last render.
    following: () => tracking.current.pinned,
  };
}
