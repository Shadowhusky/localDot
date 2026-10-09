import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { placesMoved } from "../dot/places.ts";
import { matches, REDUCED_MOTION } from "../ui/media.ts";
import { STILL_MS } from "./focus.ts";

// Pointer movement this near the screen's top or foot brings full screen's controls back.
export const EDGE_PX = 64;

export const nearEdge = (y: number, height: number, edge = EDGE_PX) =>
  y < edge || y >= height - edge;

export interface KeyPress {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  repeat: boolean;
}

// ⌘⇧F, or Ctrl+Shift+F off a Mac, which full screen takes before the computer's keyboard can.
export const isFullScreenChord = (press: KeyPress, apple: boolean) =>
  press.shift &&
  !press.alt &&
  (apple ? press.meta && !press.ctrl : press.ctrl && !press.meta) &&
  press.key.toLowerCase() === "f";

export interface KeyContext {
  full: boolean;
  // The user has the computer, so plain keys are theirs to type on it.
  yours: boolean;
  // Focus is in a field, or in a menu, sheet or dialog.
  busy: boolean;
}

// What a plain key that nothing else took does: F toggles full screen while the user watches, and
// Esc leaves it.
export function plainKey(
  press: KeyPress,
  { full, yours, busy }: KeyContext,
): "enter" | "exit" | null {
  if (press.meta || press.ctrl || press.alt || press.shift || press.repeat || busy) return null;
  if (press.key === "Escape") return full ? "exit" : null;
  if (press.key.toLowerCase() === "f" && !yours) return full ? "exit" : "enter";
  return null;
}

type Orientation = ScreenOrientation & { lock?(orientation: string): Promise<void> };

const orientation = () =>
  typeof screen === "undefined" ? undefined : (screen.orientation as Orientation | undefined);

// The element starts in the box it had and settles into its new one on the gentle spring; under
// reduced motion it only fades in. dot follows its place once the box has landed.
function travel(element: HTMLElement, from: DOMRect) {
  const to = element.getBoundingClientRect();
  if (typeof element.animate !== "function" || !to.width || !to.height) return;
  const style = getComputedStyle(element);
  const ms = (name: string, fallback: number) =>
    Number.parseFloat(style.getPropertyValue(name)) || fallback;
  const start = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  const run = (easing: string) =>
    matches(REDUCED_MOTION)
      ? element.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: ms("--dur-fade", 150),
          easing,
        })
      : element.animate(
          [
            { transformOrigin: "0 0", transform: start },
            { transformOrigin: "0 0", transform: "none" },
          ],
          { duration: ms("--dur-gentle", 670), easing },
        );
  let motion: Animation;
  try {
    motion = run(style.getPropertyValue("--ease-spring").trim() || "ease-out");
  } catch {
    motion = run("ease-out");
  }
  motion.finished.then(placesMoved, () => {});
}

export interface FullScreenOptions {
  // The live picture is on the stage; full screen ends when it goes.
  available: boolean;
  // A phone also turns to landscape where it can, and its layout swaps without travelling.
  phone: boolean;
  // The box that travels from its place to the whole screen and back.
  frame: RefObject<HTMLElement | null>;
}

// Full screen (design-v2 §11 G): the page asks the browser for the whole screen and gives it to the
// stage. Where the browser can't, as on an iPhone, the page fills the window instead.
export function useFullScreen({ available, phone, frame }: FullScreenOptions) {
  const [on, setOn] = useState(false);
  const current = useRef(on);
  const from = useRef<DOMRect | null>(null);
  const handheld = useRef(phone);
  handheld.current = phone;
  const change = useCallback(
    (next: boolean) => {
      if (current.current === next) return;
      current.current = next;
      from.current = frame.current?.getBoundingClientRect() ?? null;
      setOn(next);
    },
    [frame],
  );
  const enter = useCallback(() => {
    change(true);
    const root = document.documentElement;
    if (document.fullscreenElement || typeof root.requestFullscreen !== "function") return;
    root.requestFullscreen({ navigationUI: "hide" }).then(
      () => {
        if (handheld.current)
          orientation()
            ?.lock?.("landscape")
            .catch(() => {});
      },
      () => {},
    );
  }, [change]);
  const exit = useCallback(() => {
    change(false);
    try {
      orientation()?.unlock();
    } catch {}
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, [change]);
  useEffect(() => {
    // Esc, or the browser's own control, left the browser's full screen.
    const changed = () => {
      if (!document.fullscreenElement) change(false);
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, [change]);
  useEffect(() => {
    if (!available && current.current) exit();
  }, [available, exit]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the box travels each time full screen comes or goes
  useLayoutEffect(() => {
    const before = from.current;
    from.current = null;
    const element = frame.current;
    if (before && element && !handheld.current) travel(element, before);
  }, [on, frame]);
  return {
    on: on && available,
    enter,
    exit,
    toggle: () => (current.current ? exit() : enter()),
  };
}

const BARS = ".island-anchor, .control-strip";

// Full screen's controls fade after a still moment, and come back when the pointer moves near the
// screen's top or foot, where they are, or onto one of them. Moving over the picture itself leaves
// them hidden, since that is where the user works.
export function useEdgeStill(active: boolean, ms = STILL_MS): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    if (!active) return;
    let timer = setTimeout(() => setStill(true), ms);
    const moved = (event: PointerEvent) => {
      const onBar = event.target instanceof Element && !!event.target.closest(BARS);
      if (!onBar && !nearEdge(event.clientY, window.innerHeight)) return;
      clearTimeout(timer);
      setStill(false);
      timer = setTimeout(() => setStill(true), ms);
    };
    document.addEventListener("pointermove", moved, true);
    document.addEventListener("pointerdown", moved, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointermove", moved, true);
      document.removeEventListener("pointerdown", moved, true);
      setStill(false);
    };
  }, [active, ms]);
  return active && still;
}

const BUSY = "input, textarea, select, [contenteditable]:not([contenteditable='false']), .ui-layer";

export interface FullScreenKeysOptions extends Omit<KeyContext, "busy"> {
  enabled: boolean;
  apple: boolean;
  enter(): void;
  exit(): void;
}

// F and Esc, and ⌘⇧F ahead of the computer's own keyboard while the user has it.
export function useFullScreenKeys({
  enabled,
  apple,
  full,
  yours,
  enter,
  exit,
}: FullScreenKeysOptions) {
  const latest = useRef({ apple, full, yours, enter, exit });
  latest.current = { apple, full, yours, enter, exit };
  useEffect(() => {
    if (!enabled) return;
    const press = (event: KeyboardEvent): KeyPress => ({
      key: event.key,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      repeat: event.repeat,
    });
    const chord = (event: KeyboardEvent) => {
      const now = latest.current;
      if (!isFullScreenChord(press(event), now.apple)) return;
      event.preventDefault();
      if (!event.repeat) (now.full ? now.exit : now.enter)();
    };
    const plain = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const now = latest.current;
      const target = event.target instanceof Element ? event.target : null;
      const action = plainKey(press(event), {
        full: now.full,
        yours: now.yours,
        busy: !!target?.closest(BUSY),
      });
      if (!action) return;
      event.preventDefault();
      (action === "enter" ? now.enter : now.exit)();
    };
    window.addEventListener("keydown", chord, true);
    window.addEventListener("keydown", plain);
    return () => {
      window.removeEventListener("keydown", chord, true);
      window.removeEventListener("keydown", plain);
    };
  }, [enabled]);
}
