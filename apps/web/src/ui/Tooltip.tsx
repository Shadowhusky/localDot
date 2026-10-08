import {
  cloneElement,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { formatKeys, Kbd } from "./Kbd.tsx";
import { joinIds, mergeHandlers } from "./merge.ts";

const DELAY = 500;
// For this long after one tooltip closes, the next opens at once: the pointer is moving across a row.
const WARM = 300;
const GAP = 8;
const EDGE = 8;
// Below this much room above the trigger, a one- or two-line tooltip opens underneath instead.
const ROOM_ABOVE = 64;
// Longer than --dur-exit, so the fade finishes before the element goes.
const EXIT = 220;
// A tooltip opened by a tap has no hover to end it.
const HOLD = 3000;

type Side = "top" | "bottom";
type Phase = "closed" | "open" | "closing";
interface View {
  phase: Phase;
  side: Side;
  instant: boolean;
}

const CLOSED: View = { phase: "closed", side: "top", instant: false };

// Tooltips by their hide functions: the one open and the one fading out. Opening another hides both.
let shown: (() => void) | undefined;
let fading: (() => void) | undefined;
let warmUntil = 0;

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function createControl(setView: (update: (view: View) => View) => void) {
  let timer = 0;
  const control = {
    trigger: undefined as HTMLElement | undefined,
    held: false,
    // Safari takes focus off a button that is clicked; that blur must not close what the click opened.
    pressing: false,
    isShown: () => shown === control.hide,
    press() {
      control.pressing = true;
      for (const type of ["pointerup", "pointercancel"])
        document.addEventListener(type, control.unpress, { capture: true, once: true });
    },
    unpress() {
      control.pressing = false;
    },
    hide() {
      window.clearTimeout(timer);
      if (shown === control.hide) shown = undefined;
      if (fading === control.hide) fading = undefined;
      setView(() => CLOSED);
    },
    reveal(instant: boolean) {
      for (const other of [shown, fading]) if (other !== control.hide) other?.();
      shown = control.hide;
      fading = undefined;
      const top = control.trigger?.getBoundingClientRect().top ?? ROOM_ABOVE;
      setView(() => ({ phase: "open", side: top < ROOM_ABOVE ? "bottom" : "top", instant }));
    },
    open(trigger: HTMLElement, delay: number, held = false) {
      control.trigger = trigger;
      control.held = held;
      window.clearTimeout(timer);
      const warm = shown !== undefined || performance.now() < warmUntil;
      if (warm || delay === 0) control.reveal(warm);
      else timer = window.setTimeout(() => control.reveal(false), delay);
    },
    close() {
      window.clearTimeout(timer);
      if (shown !== control.hide) return;
      shown = undefined;
      fading = control.hide;
      warmUntil = performance.now() + WARM;
      setView((view) => ({ ...view, phase: "closing", instant: false }));
    },
  };
  return control;
}

export interface TooltipOptions {
  content: ReactNode;
  kbd?: readonly string[];
  // Read through aria-describedby whether or not the tooltip is open.
  description?: ReactNode;
  // Pressing the trigger opens it at once, by touch too: for a reason the control can't otherwise show.
  showOnPress?: boolean;
}

export function useTooltip({ content, kbd, description, showOnPress = false }: TooltipOptions) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(CLOSED);
  const [control] = useState(() => createControl(setView));
  const empty = content === undefined || content === null || content === "" || content === false;
  const described = description !== undefined && description !== null && description !== "";

  useEffect(() => control.hide, [control]);

  useEffect(() => {
    if (view.phase !== "closing") return;
    const done = window.setTimeout(
      () => setView((current) => (current.phase === "closing" ? CLOSED : current)),
      EXIT,
    );
    return () => window.clearTimeout(done);
  }, [view.phase]);

  useEffect(() => {
    if (view.phase !== "open") return;
    const away = (event: Event) => {
      if (!control.trigger?.contains(event.target as Node)) control.close();
    };
    // Escape on a focused trigger is handled, and kept from the page, by the trigger itself.
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") control.close();
    };
    const hold = control.held ? window.setTimeout(control.close, HOLD) : 0;
    window.addEventListener("scroll", control.hide, { capture: true, passive: true });
    window.addEventListener("resize", control.hide);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", dismiss);
    return () => {
      window.clearTimeout(hold);
      window.removeEventListener("scroll", control.hide, { capture: true });
      window.removeEventListener("resize", control.hide);
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", dismiss);
    };
  }, [view.phase, control]);

  useLayoutEffect(() => {
    const element = popup.current;
    const anchor = control.trigger?.getBoundingClientRect();
    if (view.phase !== "open" || !element || !anchor) return;
    const { offsetWidth: width, offsetHeight: height } = element;
    const top = view.side === "top" ? anchor.top - GAP - height : anchor.bottom + GAP;
    const centre = anchor.left + anchor.width / 2;
    const left = Math.min(Math.max(centre - width / 2, EDGE), window.innerWidth - EDGE - width);
    element.style.top = `${Math.round(top)}px`;
    element.style.left = `${Math.round(left)}px`;
    element.style.transformOrigin = `${Math.round(centre - left)}px ${view.side === "top" ? "100%" : "0"}`;
  }, [view.phase, view.side, control]);

  const descriptionId = `${id}-description`;
  const triggerProps = {
    "aria-describedby": described ? descriptionId : undefined,
    "aria-keyshortcuts": kbd ? formatKeys(kbd).aria : undefined,
    handlers: {
      onPointerEnter(event: PointerEvent<HTMLElement>) {
        if (!empty && event.pointerType !== "touch") control.open(event.currentTarget, DELAY);
      },
      onPointerLeave(event: PointerEvent<HTMLElement>) {
        if (event.pointerType !== "touch") control.close();
      },
      onPointerDown(event: PointerEvent<HTMLElement>) {
        control.press();
        if (showOnPress && !empty)
          control.open(event.currentTarget, 0, event.pointerType === "touch");
        else if (event.pointerType !== "touch") control.close();
      },
      onFocus(event: FocusEvent<HTMLElement>) {
        if (!empty && focusVisible(event.currentTarget)) control.open(event.currentTarget, DELAY);
      },
      onBlur() {
        if (!control.pressing) control.close();
      },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (event.key !== "Escape" || !control.isShown()) return;
        event.stopPropagation();
        control.close();
      },
    },
  };

  const tooltip = (
    <>
      {described &&
        createPortal(
          <span hidden id={descriptionId}>
            {description}
          </span>,
          document.body,
        )}
      {view.phase !== "closed" &&
        createPortal(
          <div
            ref={popup}
            className="ui-tooltip"
            aria-hidden="true"
            data-side={view.side}
            data-instant={view.instant ? "" : undefined}
            data-closing={view.phase === "closing" ? "" : undefined}
          >
            <span className="ui-tooltip-text">{content}</span>
            {kbd && <Kbd keys={kbd} />}
          </div>,
          document.body,
        )}
    </>
  );

  return { triggerProps, tooltip };
}

interface TriggerProps {
  "aria-describedby"?: string;
  "aria-keyshortcuts"?: string;
}

export interface TooltipProps {
  content: ReactNode;
  kbd?: readonly string[];
  children: ReactElement<TriggerProps>;
}

export function Tooltip({ content, kbd, children }: TooltipProps) {
  const { triggerProps, tooltip } = useTooltip({ content, kbd, description: content });
  const own = children.props;
  return (
    <>
      {cloneElement(children, {
        ...mergeHandlers(own, triggerProps.handlers),
        "aria-describedby": joinIds(own["aria-describedby"], triggerProps["aria-describedby"]),
        "aria-keyshortcuts": triggerProps["aria-keyshortcuts"] ?? own["aria-keyshortcuts"],
      })}
      {tooltip}
    </>
  );
}
