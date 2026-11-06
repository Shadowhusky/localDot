import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { matches, REDUCED_MOTION } from "../ui/media.ts";
import { tokenMs } from "../ui/motion.ts";

interface Frame {
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

function frameOf(card: HTMLElement | null): Frame | null {
  const field = card?.querySelector("textarea")?.getBoundingClientRect();
  if (!card || !field) return null;
  return { height: card.getBoundingClientRect().height, x: field.left, y: field.top };
}

// The card's real height changes, so the thread above follows it frame by frame and nothing jumps;
// Attach, Voice and Send sit on the card's last line both ways and never move. A phone's toolbar
// leaves the keyboard as focus does, back onto the thread's foot at its resting height: closing, the
// card takes only that height there and folds down into it, over the thread.
function glide(card: HTMLElement, from: Frame): Animation[] {
  const field = card.querySelector("textarea");
  const to = frameOf(card);
  if (!field || !to || matches(REDUCED_MOTION) || typeof card.animate !== "function") return [];
  const style = getComputedStyle(card);
  const timing = {
    duration: tokenMs(style, "--dur-snappy", 340),
    easing: style.getPropertyValue("--ease-standard").trim() || "ease-out",
  };
  const over = card.matches('[data-layout="pill"]') ? Math.max(0, from.height - to.height) : 0;
  const height = card.animate(
    [
      { height: `${from.height}px`, marginBlockStart: `${-over}px` },
      { height: `${to.height}px`, marginBlockStart: "0" },
    ],
    timing,
  );
  card.toggleAttribute("data-folding", true);
  height.finished.then(
    () => card.removeAttribute("data-folding"),
    () => {},
  );
  return [
    height,
    field.animate(
      [{ translate: `${from.x - to.x}px ${from.y - to.y}px` }, { translate: "0 0" }],
      timing,
    ),
  ];
}

// Unfocused and with nothing written, the composer is one row. The field's focus opens the rest of
// its controls, and they stay while focus is anywhere in the card, while a popover from them is open
// or while `held`: what is written or attached.
export function useComposerFold(card: RefObject<HTMLFormElement | null>, held: boolean) {
  const [using, setUsing] = useState(false);
  const pressing = useRef(false);
  const leave = useCallback(() => {
    if (!pressing.current && !card.current?.querySelector('[aria-expanded="true"]'))
      setUsing(false);
  }, [card]);
  // After a press or a popover: once what it did has settled, and focus has gone back or not.
  const settle = useCallback(() => {
    requestAnimationFrame(() => {
      if (!card.current?.contains(document.activeElement)) leave();
    });
  }, [card, leave]);
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    const popovers = new MutationObserver(settle);
    popovers.observe(element, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-expanded"],
    });
    // A press anywhere takes focus from the field and, in Safari, gives it to nothing. The thread
    // moves with the card, so the row holds still until the press is over and has done what it does,
    // or what was pressed would leave the pointer and never get its click. A tap's mouse events come
    // after its pointer's, and are what moves focus. Only a phone's toolbar on the keyboard folds at
    // once when pressed outside: it folds over the thread, which stays put.
    const pressed = (event: Event) => {
      pressing.current =
        (event.target instanceof Node && !!card.current?.contains(event.target)) ||
        !document.querySelector(".app[data-composer-keyboard]");
    };
    const released = () => {
      if (!pressing.current) return;
      pressing.current = false;
      settle();
    };
    const listens = [
      ["pointerdown", pressed],
      ["mousedown", pressed],
      ["pointerup", released],
      ["mouseup", released],
      ["pointercancel", released],
    ] as const;
    for (const [name, listener] of listens) document.addEventListener(name, listener, true);
    return () => {
      popovers.disconnect();
      for (const [name, listener] of listens) document.removeEventListener(name, listener, true);
    };
  }, [card, settle]);

  const compact = !using && !held;
  const shown = useRef(compact);
  const before = useRef<Frame | null>(null);
  const moving = useRef<Animation[]>([]);
  if (shown.current !== compact) {
    shown.current = compact;
    before.current = frameOf(card.current);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: the fold changing is the trigger.
  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    if (!from || !card.current) return;
    for (const motion of moving.current) motion.cancel();
    moving.current = glide(card.current, from);
  }, [card, compact]);

  return {
    compact,
    onFocus: (event: { target: EventTarget }) => {
      if (event.target instanceof HTMLTextAreaElement) setUsing(true);
    },
    // At once, not a frame on: a phone's toolbar leaves the keyboard in the next frame, at this height.
    onBlur: (event: { relatedTarget: EventTarget | null }) => {
      const within =
        event.relatedTarget instanceof Node && card.current?.contains(event.relatedTarget);
      if (!within && document.hasFocus()) leave();
    },
  };
}
