import {
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { OutsideField } from "./Field.tsx";
import { IconButton } from "./IconButton.tsx";

const GAP = 4;
const EDGE = 8;
const MAX_HEIGHT = 360;
const MIN_WIDTH = 240;
// With less room than this under the trigger, a list opens above it when there is more room there.
const ROOM = 200;
// Longer than the sheet's exit, so it finishes before the surface goes. Until then the surface still
// takes the taps that land on it, so the click a touch sends after a choice never reaches the page.
const EXIT = 320;
// A released sheet closes when it would come to rest past this share of its height.
const DISMISS_SHARE = 0.3;
const DECELERATION = 0.998;
// Held this long without moving, a drag lets go with no speed.
const STILL_MS = 80;
// The ease a flung sheet leaves on starts at about this multiple of its average speed.
const EASE_ENTER_SLOPE = 4.35;
const REST_OF_PRESS = ["pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu"];
const NEXT_GESTURE = ["pointerdown", "pointercancel", "keydown"];

export type Presentation = "popover" | "sheet";

// A phone gets a bottom sheet; a desktop, or a tablet with room, gets a popover by the trigger.
export function presentationNow(): Presentation {
  return typeof matchMedia === "function" &&
    matchMedia("(width < 760px) and (pointer: coarse)").matches
    ? "sheet"
    : "popover";
}

// A press that closed a popup is spent: the rest of it, its click included, never reaches the page or
// a sheet that closes on a click of its backdrop. The next press, or a key, is the page's again.
function swallowRestOfPress() {
  const swallow = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
    if (event.type === "click") release();
  };
  const release = () => {
    for (const type of REST_OF_PRESS) window.removeEventListener(type, swallow, true);
    for (const type of NEXT_GESTURE) window.removeEventListener(type, release, true);
  };
  for (const type of REST_OF_PRESS) window.addEventListener(type, swallow, true);
  for (const type of NEXT_GESTURE) window.addEventListener(type, release, true);
}

function project(velocity: number): number {
  return ((velocity / 1000) * DECELERATION) / (1 - DECELERATION);
}

function rubberband(overshoot: number, dimension: number): number {
  const constant = 0.55;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

interface Drag {
  from: number;
  y: number;
  samples: [number, number][];
}

export interface PickerPopupProps {
  open: boolean;
  presentation: Presentation;
  anchor: RefObject<HTMLElement | null>;
  title: string;
  // A popover around a search field and its list is a dialog; one around a bare list is the list.
  dialog?: boolean;
  // Never move the search field as the list filters: the sheet stays full height, and a popover
  // above its trigger keeps the height it opened at.
  holdHeight?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  armed: RefObject<boolean>;
  onDismiss(): void;
  header?: ReactNode;
  children: ReactNode;
}

export function PickerPopup({
  open,
  presentation,
  anchor,
  title,
  dialog = false,
  holdHeight = false,
  initialFocus,
  armed,
  onDismiss,
  header,
  children,
}: PickerPopupProps) {
  const titleId = useId();
  const surface = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const placement = useRef<{ side: "top" | "bottom"; height?: number } | undefined>(undefined);
  const drag = useRef<Drag | undefined>(undefined);
  const scrimDown = useRef(false);
  const opened = useRef(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const closing = present && !open;

  useEffect(() => {
    if (!closing) return;
    const done = window.setTimeout(() => setPresent(false), EXIT);
    return () => window.clearTimeout(done);
  }, [closing]);

  const place = () => {
    const panel = surface.current;
    const trigger = anchor.current;
    if (!panel || !trigger || presentation !== "popover") return;
    const rect = trigger.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    const below = height - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    if (!placement.current) {
      const list = panel.querySelector(".ui-listbox");
      const natural = panel.offsetHeight + (list ? list.scrollHeight - list.clientHeight : 0);
      const side = below >= Math.min(natural, ROOM) || below >= above ? "bottom" : "top";
      const room = Math.min(MAX_HEIGHT, side === "bottom" ? below : above);
      // Below the trigger the search field sits at the fixed top edge; above it, the list grows up
      // from the trigger, so its height is held or filtering would move the field being typed in.
      const hold = holdHeight && side === "top";
      placement.current = { side, height: hold ? Math.min(natural, room) : undefined };
    }
    const { side, height: held } = placement.current;
    const room = Math.max(Math.min(MAX_HEIGHT, side === "bottom" ? below : above), 0);
    const panelWidth = Math.min(Math.max(rect.width, MIN_WIDTH), width - 2 * EDGE);
    const left = Math.min(Math.max(rect.left, EDGE), width - EDGE - panelWidth);
    const style = panel.style;
    style.width = `${panelWidth}px`;
    style.left = `${left}px`;
    style.maxHeight = `${room}px`;
    if (held !== undefined) style.height = `${Math.min(held, room)}px`;
    style.top = side === "bottom" ? `${rect.bottom + GAP}px` : "";
    style.bottom = side === "top" ? `${height - rect.top + GAP}px` : "";
    style.transformOrigin = `${rect.left + rect.width / 2 - left}px ${side === "bottom" ? "0" : "100%"}`;
    panel.dataset.side = side;
  };

  // Focus moves in when the surface opens, and back to the trigger when it closes. Both happen after
  // React's commit, which would otherwise hand focus back to a search field it saw focused.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening and closing; the rest are refs
  useLayoutEffect(() => {
    if (open) {
      opened.current = true;
      place();
      initialFocus?.current?.focus({ preventScroll: true });
      return;
    }
    if (!opened.current) return;
    opened.current = false;
    placement.current = undefined;
    const focused = document.activeElement;
    if (!focused || focused === document.body || surface.current?.contains(focused))
      anchor.current?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    if (open) place();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: place reads only refs and fixed props
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      Boolean(
        surface.current?.contains(target) ||
          scrim.current?.contains(target) ||
          anchor.current?.contains(target),
      );
    // An outside press or Escape closes only this popup; neither reaches a sheet beneath it.
    const pressed = (event: globalThis.PointerEvent) => {
      if (inside(event.target)) return;
      event.stopPropagation();
      swallowRestOfPress();
      dismiss.current();
    };
    const escaped = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      dismiss.current();
    };
    const released = () => {
      armed.current = false;
    };
    let frame = 0;
    const moved = (event: Event) => {
      if (event.target instanceof Node && surface.current?.contains(event.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    document.addEventListener("pointerdown", pressed, true);
    document.addEventListener("keydown", escaped, true);
    document.addEventListener("pointerup", released);
    window.addEventListener("scroll", moved, { capture: true, passive: true });
    window.addEventListener("resize", moved);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", pressed, true);
      document.removeEventListener("keydown", escaped, true);
      document.removeEventListener("pointerup", released);
      window.removeEventListener("scroll", moved, { capture: true });
      window.removeEventListener("resize", moved);
    };
  }, [open, armed, anchor]);

  // The page under a sheet stays where it is.
  useLayoutEffect(() => {
    if (!open || presentation !== "sheet") return;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = before;
    };
  }, [open, presentation]);

  if (!present) return null;

  // A mouse press inside keeps focus where it is (the trigger, the search field or the list), so a
  // choice made with the pointer never blurs it. A touch is left alone: it must still scroll the list.
  const keepFocus = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && !(event.target as Element).closest("input, button"))
      event.preventDefault();
  };

  if (presentation === "popover")
    return createPortal(
      <div
        ref={surface}
        className="ui-picker ui-popover"
        {...(dialog && { role: "dialog", "aria-label": title })}
        data-closing={closing ? "" : undefined}
        onPointerDown={keepFocus}
      >
        <OutsideField>
          {header}
          {children}
        </OutsideField>
      </div>,
      document.body,
    );

  // The sheet follows the finger from where it was grabbed, and a fling carries it on.
  const grab = (event: PointerEvent<HTMLDivElement>) => {
    const panel = surface.current;
    if (!open || !panel || event.button !== 0 || (event.target as Element).closest("button"))
      return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { from: event.clientY, y: 0, samples: [[event.timeStamp, 0]] };
    panel.style.transition = "none";
  };
  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const moving = drag.current;
    const panel = surface.current;
    if (!moving || !panel) return;
    const dy = event.clientY - moving.from;
    moving.y = dy >= 0 ? dy : rubberband(dy, panel.offsetHeight);
    panel.style.translate = `0 ${moving.y}px`;
    moving.samples.push([event.timeStamp, moving.y]);
    while (moving.samples.length > 2 && event.timeStamp - (moving.samples[0]?.[0] ?? 0) > 100)
      moving.samples.shift();
  };
  const letGo = (event: PointerEvent<HTMLDivElement>) => {
    const moving = drag.current;
    const panel = surface.current;
    drag.current = undefined;
    if (!moving || !panel) return;
    const [t0, y0] = moving.samples[0] ?? [0, 0];
    const [t1, y1] = moving.samples.at(-1) ?? [0, 0];
    // A finger that stopped before it lifted carries no speed.
    const still = event.timeStamp - t1 > STILL_MS;
    const velocity = t1 > t0 && !still ? ((y1 - y0) / (t1 - t0)) * 1000 : 0;
    const height = panel.offsetHeight;
    if (event.type === "pointerup" && moving.y + project(velocity) > height * DISMISS_SHARE) {
      const speed = Math.max(velocity, 1);
      const duration = Math.min(
        Math.max((EASE_ENTER_SLOPE * (height - moving.y) * 1000) / speed, 160),
        360,
      );
      panel.style.transition = `translate ${Math.round(duration)}ms var(--ease-enter)`;
      panel.style.translate = "0 100%";
      dismiss.current();
    } else {
      panel.style.transition = "";
      panel.style.translate = "";
    }
  };

  return createPortal(
    <>
      <div
        ref={scrim}
        className="ui-picker-scrim"
        data-closing={closing ? "" : undefined}
        onPointerDown={() => {
          scrimDown.current = true;
        }}
        onPointerUp={() => {
          if (scrimDown.current && open) dismiss.current();
          scrimDown.current = false;
        }}
      />
      <div
        ref={surface}
        className="ui-picker ui-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-full={holdHeight ? "" : undefined}
        data-closing={closing ? "" : undefined}
        onPointerDown={(event) => {
          scrimDown.current = false;
          keepFocus(event);
        }}
      >
        <div
          className="ui-sheet-head"
          onPointerDown={grab}
          onPointerMove={follow}
          onPointerUp={letGo}
          onPointerCancel={letGo}
        >
          <span className="ui-sheet-grabber" aria-hidden="true" />
          <h2 id={titleId} className="ui-sheet-title">
            {title}
          </h2>
          <IconButton
            className="ui-sheet-close"
            label="Close"
            icon="x"
            size={32}
            onClick={() => dismiss.current()}
          />
        </div>
        <OutsideField>
          {header}
          {children}
        </OutsideField>
      </div>
    </>,
    document.body,
  );
}
