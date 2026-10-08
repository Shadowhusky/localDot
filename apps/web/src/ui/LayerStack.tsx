import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { ownedByPicker } from "../lib/dismiss.ts";
import { canFocus, focusWithoutScroll, tabbables } from "./focus.ts";

// One stack orders every open overlay: Escape goes to the topmost layer only, and focus stays inside
// the topmost layer that traps it (and anything opened above that).
export interface LayerEntry {
  // Everything the layer puts on the page: its popup and any scrim or catcher behind it.
  root(): HTMLElement | null;
  // The element that holds focus for the layer.
  panel(): HTMLElement | null;
  trap: boolean;
  modal: boolean;
  escape(): void;
}

const stack: LayerEntry[] = [];
const listeners = new Set<() => void>();
let direction: 1 | -1 = 1;
let modality: "keyboard" | "pointer" = "pointer";
// Pointers now down, so a closing layer can wait for their release.
const pressed = new Set<number>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function trapping(): number {
  return stack.findLastIndex((entry) => entry.trap);
}

function insideFrom(index: number, node: EventTarget | null): boolean {
  return (
    node instanceof Node &&
    stack.slice(index).some((entry) => entry.root()?.contains(node) ?? false)
  );
}

function enter(entry: LayerEntry, last: boolean) {
  const panel = entry.panel();
  if (!panel) return;
  const items = tabbables(panel);
  focusWithoutScroll((last ? items.at(-1) : items[0]) ?? panel);
}

function onKeyDown(event: KeyboardEvent) {
  if (!event.metaKey && !event.ctrlKey) modality = "keyboard";
  if (event.key === "Escape") {
    if (event.isComposing || ownedByPicker(event)) return;
    const top = stack.at(-1);
    if (!top) return;
    event.preventDefault();
    top.escape();
    return;
  }
  if (event.key !== "Tab") return;
  direction = event.shiftKey ? -1 : 1;
  const index = trapping();
  const entry = stack[index];
  const panel = entry?.panel();
  if (!entry || !panel) return;
  const active = document.activeElement;
  if (!insideFrom(index, active)) {
    event.preventDefault();
    enter(entry, event.shiftKey);
    return;
  }
  if (!panel.contains(active)) return;
  const items = tabbables(panel);
  const edge = event.shiftKey ? items[0] : items.at(-1);
  if (items.length === 0 || active === edge || active === panel) {
    event.preventDefault();
    enter(entry, event.shiftKey);
  }
}

// Focus that leaves the trapping layer (Safari tabs past the last field into the page; app code may
// focus something behind) comes back in at the end it left from.
function onFocusIn(event: FocusEvent) {
  const index = trapping();
  const entry = stack[index];
  if (!entry || insideFrom(index, event.target)) return;
  enter(entry, direction < 0);
}

function onKeyUp(event: KeyboardEvent) {
  if (event.key === "Tab") direction = 1;
}

function onPointerDown(event: PointerEvent) {
  modality = "pointer";
  pressed.add(event.pointerId);
}

function onPointerUp(event: PointerEvent) {
  pressed.delete(event.pointerId);
}

if (typeof document !== "undefined") {
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerUp, true);
  // A release outside the window may never arrive.
  window.addEventListener("blur", () => pressed.clear());
}

export function lastModality(): "keyboard" | "pointer" {
  return modality;
}

export function pushLayer(entry: LayerEntry): () => void {
  stack.push(entry);
  notify();
  return () => {
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    notify();
  };
}

export function isTopmost(entry: LayerEntry): boolean {
  return stack.at(-1) === entry;
}

// True while a modal layer is open above this one: the layer below is pushed back.
export function useBehind(entry: LayerEntry | undefined): boolean {
  return useSyncExternalStore(subscribe, () => {
    const index = entry ? stack.indexOf(entry) : -1;
    return index >= 0 && stack.slice(index + 1).some((above) => above.modal);
  });
}

export interface LayerOptions {
  active: boolean;
  root: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLElement | null>;
  trap: boolean;
  modal: boolean;
  onEscape(): void;
  // Where focus goes on opening; the panel itself when this finds nothing.
  initialFocus?(panel: HTMLElement): HTMLElement | undefined;
  // Where focus goes back to on closing, if it was still inside. Defaults to what had focus before.
  returnFocus?: RefObject<HTMLElement | null>;
}

// Registers an open layer, moves focus in, and on closing puts focus back where it came from,
// unless the user has since put it somewhere else.
export function useLayer(options: LayerOptions): LayerEntry | undefined {
  const latest = useRef(options);
  latest.current = options;
  const opener = useRef<Element | null>(null);
  const [entry, setEntry] = useState<LayerEntry>();
  const { active, trap, modal } = options;

  useLayoutEffect(() => {
    if (!active) return;
    opener.current = document.activeElement;
    const own: LayerEntry = {
      root: () => latest.current.root.current,
      panel: () => latest.current.panel.current,
      trap,
      modal,
      escape: () => latest.current.onEscape(),
    };
    const remove = pushLayer(own);
    setEntry(own);
    const panel = latest.current.panel.current;
    if (panel && !panel.contains(document.activeElement))
      focusWithoutScroll(latest.current.initialFocus?.(panel) ?? panel);
    return () => {
      remove();
      setEntry(undefined);
    };
  }, [active, trap, modal]);

  // After the commit, not during it: React puts focus back on whatever had it before a commit that
  // moved it, which would undo a focus change made while the layer's DOM was updating.
  useEffect(() => {
    if (!active) return;
    return () => {
      const back = latest.current.returnFocus?.current ?? opener.current;
      const focused = document.activeElement;
      const lost =
        !focused ||
        focused === document.body ||
        (latest.current.root.current?.contains(focused) ?? false);
      if (lost && canFocus(back)) focusWithoutScroll(back);
    };
  }, [active]);

  return entry;
}

// Keeps a closing layer on the page while it animates out, and while a press that closed it is
// still down (up to a limit), so the release cannot land on whatever lies beneath.
const HOLD_LIMIT = 1000;

export function useExit(open: boolean, duration: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const timers: number[] = [];
    const stop = new AbortController();
    const unmount = () => setMounted(false);
    timers.push(
      window.setTimeout(() => {
        if (pressed.size === 0) return unmount();
        const release = () => timers.push(window.setTimeout(unmount, 100));
        for (const type of ["pointerup", "pointercancel"])
          document.addEventListener(type, release, { capture: true, signal: stop.signal });
        timers.push(window.setTimeout(unmount, HOLD_LIMIT));
      }, duration),
    );
    return () => {
      stop.abort();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [open, mounted, duration]);
  return { mounted: open || mounted, closing: !open && mounted };
}

export interface LayerPortalProps {
  kind: "sheet" | "dialog" | "popover" | "menu";
  closing: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  className?: string;
  children: ReactNode;
}

// Every layer is a fixed box over the page in its own portal. Later layers sit later in the body, so
// at the same z-index they paint above earlier ones.
export function LayerPortal({ kind, closing, rootRef, className, children }: LayerPortalProps) {
  return createPortal(
    <div
      ref={rootRef}
      className={className ? `ui-layer ${className}` : "ui-layer"}
      data-kind={kind}
      data-closing={closing ? "" : undefined}
    >
      {children}
    </div>,
    document.body,
  );
}
