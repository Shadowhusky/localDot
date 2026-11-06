import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { placesMoved } from "../dot/places.ts";
import { matches, REDUCED_MOTION } from "../ui/media.ts";
import { tokenMs } from "../ui/motion.ts";

// Where the card is drawn and where its words are in it: the card's height, the top of the words'
// box under the card's top edge, and the box's left edge.
interface Frame {
  readonly height: number;
  readonly top: number;
  readonly x: number;
}

interface Place extends Frame {
  readonly words: number;
  // How far the words' box can move either way and stay in the card.
  readonly left: number;
  readonly right: number;
  // The controls drawn in the row under the words.
  readonly controls: readonly Element[];
}

function placeOf(card: HTMLElement | null): Place | null {
  const field = card?.querySelector("textarea");
  if (!card || !field) return null;
  const outer = card.getBoundingClientRect();
  const box = field.getBoundingClientRect();
  const style = getComputedStyle(field);
  const [top, right, bottom, left] = [
    style.paddingTop,
    style.paddingRight,
    style.paddingBottom,
    style.paddingLeft,
  ].map(Number.parseFloat) as [number, number, number, number];
  const x = box.left + field.clientLeft + left;
  return {
    height: outer.height,
    top: box.top + field.clientTop + top - outer.top,
    x,
    words: field.clientHeight - top - bottom,
    left: x - outer.left,
    right: outer.right - (x + field.clientWidth - left - right),
    controls: [...card.querySelectorAll(".composer-bar > *")].filter(
      (control) => control.getClientRects().length > 0,
    ),
  };
}

const between = (from: number, to: number, progress: number) => from + (to - from) * progress;

interface Glide {
  // The field changed size on the way: go on from where everything is drawn to where it now rests.
  refit(): void;
  cancel(): void;
}

// The card's real height changes, so the thread above follows it frame by frame and nothing jumps;
// Attach, Voice and Send sit on the card's last line both ways and never move. The words keep their
// place under the card's top edge and go with it, and the controls that open in the row come in once
// the words have risen clear of them. Whatever is typed or pasted on the way still fits: the card goes
// on to the height that holds it, from where it is. A phone's toolbar lying over the thread on the
// keyboard leaves it as focus does, back onto the thread's foot at its resting height: closing, the
// card takes only that height there and folds down into it, over the thread. Anywhere else the thread
// and dot's line at its foot follow the card down as they follow it up.
function glide(card: HTMLElement, start: Place): Glide | null {
  const field = card.querySelector("textarea");
  if (!field || matches(REDUCED_MOTION) || typeof card.animate !== "function") return null;
  const style = getComputedStyle(card);
  const timing = {
    duration: tokenMs(style, "--dur-snappy", 340),
    easing: style.getPropertyValue("--ease-standard").trim() || "ease-out",
  };
  const sizeOf = () => `${field.offsetWidth} ${field.offsetHeight}`;
  let motions: Animation[] = [];
  let size = "";
  // Where it goes from and to, the progress at which the opening controls start to come in, and
  // how far in they already were.
  let plan: { from: Frame; to: Frame; at: number; shown: number } | undefined;

  const play = (drawn: Frame, shown: number) => {
    const to = placeOf(card);
    if (!to) return;
    size = sizeOf();
    // Words that came in on the way may not fit where the field was drawn: they start higher, the
    // card no shorter than they are, and written words no further across than the card holds them.
    const height = Math.max(drawn.height, to.words);
    const from = {
      height,
      top: Math.min(Math.max(drawn.top, 0), height - to.words),
      x: field.value ? Math.min(Math.max(drawn.x, to.x - to.left), to.x + to.right) : drawn.x,
    };
    const bottom = card.getBoundingClientRect().bottom;
    const opening = to.controls.filter(
      (control): control is HTMLElement =>
        control instanceof HTMLElement && !start.controls.includes(control),
    );
    // The room between the words and the opening controls under them changes in a straight line
    // with the eased progress the height runs on, which keyframe offsets are also read in.
    const rise = Math.max(
      0,
      ...opening.map((control) => bottom - control.getBoundingClientRect().top),
    );
    const room = (frame: Frame) => frame.height - rise - frame.top - to.words;
    const [first, last] = [room(from), room(to)];
    const clear = first >= 0 ? 0 : last > first ? Math.min(1, -first / (last - first)) : 1;
    const keep = clear === 0 && shown > 0;
    plan = { from, to, at: clear, shown: keep ? shown : 0 };
    const over = card.closest(".app[data-composer-keyboard]")
      ? Math.max(0, from.height - to.height)
      : 0;
    const resize = card.animate(
      [
        { height: `${from.height}px`, marginBlockStart: `${-over}px` },
        { height: `${to.height}px`, marginBlockStart: "0" },
      ],
      timing,
    );
    card.toggleAttribute("data-folding", true);
    resize.finished.then(
      () => card.removeAttribute("data-folding"),
      () => {},
    );
    const dx = from.x - to.x;
    const dy = to.height - from.height + from.top - to.top;
    motions = [
      resize,
      field.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], timing),
      ...opening.map((control) =>
        control.animate(
          keep
            ? [{ opacity: shown }, { opacity: 1 }]
            : [{ opacity: 0 }, { opacity: 0, offset: clear }, { opacity: 1 }],
          timing,
        ),
      ),
    ];
    // One start for all, once the browser has given each one: the height runs on the page and the
    // rest can run on the compositor, which may start a frame later and hold the words back over the
    // row. The timeline's time is no start to give them, as it stands still on an idle page.
    const started = motions;
    Promise.all(started.map((motion) => motion.ready)).then(
      () => {
        const at = started[0]?.startTime ?? null;
        for (const motion of started) if (motion.startTime !== at) motion.startTime = at;
      },
      () => {},
    );
    // The thread above follows the card, and dot's place at its foot with it: a card that starts
    // taller than it was drawn moves that place before any frame of its own says so.
    placesMoved();
  };
  const cancel = () => {
    for (const motion of motions) motion.cancel();
  };
  play(start, 0);
  return {
    refit() {
      const resize = motions[0];
      if (!plan || resize?.playState !== "running" || size === sizeOf()) return;
      const progress = resize.effect?.getComputedTiming().progress ?? 0;
      const { from, to, at, shown } = plan;
      const drawn = {
        height: between(from.height, to.height, progress),
        top: between(from.top, to.top, progress),
        x: between(from.x, to.x, progress),
      };
      const opacity = progress <= at ? 0 : between(shown, 1, (progress - at) / (1 - at));
      cancel();
      play(drawn, opacity);
    },
    cancel,
  };
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
  const before = useRef<Place | null>(null);
  const moving = useRef<Glide | null>(null);
  if (shown.current !== compact) {
    shown.current = compact;
    before.current = placeOf(card.current);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: the fold changing is the trigger.
  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    if (!from || !card.current) return;
    moving.current?.cancel();
    moving.current = glide(card.current, from);
  }, [card, compact]);
  // After layout and before the frame is drawn, so no frame shows the words out of place.
  useEffect(() => {
    const field = card.current?.querySelector("textarea");
    if (!field || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => moving.current?.refit());
    observer.observe(field);
    return () => observer.disconnect();
  }, [card]);

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
