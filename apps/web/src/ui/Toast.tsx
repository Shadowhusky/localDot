import {
  type FocusEvent,
  type KeyboardEvent,
  memo,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "./Button.tsx";
import { DetailLines } from "./Disclosure.tsx";
import { afterMotion } from "./finished.ts";
import { canFocus, focusWithoutScroll, tabbables } from "./focus.ts";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { matches, REDUCED_MOTION } from "./media.ts";
import { attachToastSwipe } from "./toast-swipe.ts";
import { createToasts, type Toast, type ToastOptions } from "./toasts.ts";

// After a press on the toast that makes no click (a swipe, a scroll), it is let go this much later.
const PRESS_CLICK_WAIT = 300;
// Below the anchor.
const ANCHOR_GAP = 8;

const shared = createToasts();

export function showToast(options: ToastOptions): string {
  return shared.show(options);
}

// What the toast said no longer holds; one not shown yet never shows.
export function dismissToast(id: string): void {
  shared.withdraw(id);
}

export interface ToasterProps {
  // The toast hangs this far below it, centred on it, in the box both share.
  anchor: RefObject<HTMLElement | null>;
  label?: string;
}

// Where the toast sits: under the anchor, in the anchor's own positioned box, out of the flow. The
// anchor can move without changing size, so while a toast is up it is measured every frame.
function useAnchoredTo(
  anchor: RefObject<HTMLElement | null>,
  region: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useLayoutEffect(() => {
    if (!active) return;
    let frame = 0;
    let placed = "";
    const place = () => {
      frame = requestAnimationFrame(place);
      const own = region.current;
      const target = anchor.current;
      const parent = own?.offsetParent;
      if (!own || !target || !(parent instanceof HTMLElement)) return;
      // A toast rises with its anchor over a sheet's scrim.
      own.toggleAttribute("data-lifted", !!target.closest("[data-lifted]"));
      const box = parent.getBoundingClientRect();
      const at = target.getBoundingClientRect();
      const top = at.bottom - box.top - parent.clientTop + parent.scrollTop + ANCHOR_GAP;
      const x = at.left + at.width / 2 - box.left - parent.clientLeft + parent.scrollLeft;
      if (`${top} ${x}` === placed) return;
      placed = `${top} ${x}`;
      own.style.setProperty("--_top", `${top}px`);
      own.style.setProperty("--_x", `${x}px`);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [anchor, region, active]);
}

// Where focus can go back to in the anchor: the anchor itself, or the first control in it.
function anchorFocus(anchor: HTMLElement | null): HTMLElement | undefined {
  if (!anchor) return undefined;
  return [anchor, ...tabbables(anchor)].find(
    (element) => element.tabIndex >= 0 && canFocus(element),
  );
}

// One toast at a time hangs from the anchor; the queue behind it is the store's.
export function Toaster({ anchor, label = "Notifications" }: ToasterProps) {
  const toasts = useSyncExternalStore(shared.subscribe, shared.list, shared.list);
  const region = useRef<HTMLElement>(null);
  const cameFrom = useRef<Element | null>(null);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [swiping, setSwiping] = useState(0);
  const [pressing, setPressing] = useState(false);
  const held = hovering || focused || swiping > 0 || pressing;
  const front = toasts.find((toast) => !toast.leaving);
  useAnchoredTo(anchor, region, toasts.length > 0);

  useEffect(() => {
    shared.hold("toaster", held);
    return () => shared.hold("toaster", false);
  }, [held]);

  // A press holds the toast until the click it makes on it has been handled, or until a moment
  // after a press that makes none there.
  useEffect(() => {
    if (!pressing) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const letGo = (after: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => setPressing(false), after);
    };
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Node && region.current?.contains(event.target)) letGo(0);
    };
    const onUp = () => letGo(PRESS_CLICK_WAIT);
    window.addEventListener("click", onClick, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [pressing]);
  useEffect(() => {
    const onVisibility = () => shared.hold("hidden", document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      shared.hold("hidden", false);
    };
  }, []);

  // Focus inside a toast that goes moves back to where it came from, or to the anchor.
  const dismiss = useCallback(
    (id: string, how?: Toast["leaving"]) => {
      if (region.current?.contains(document.activeElement)) {
        const origin = region.current.contains(cameFrom.current) ? null : cameFrom.current;
        const target = [origin].find(canFocus) ?? anchorFocus(anchor.current);
        if (target) focusWithoutScroll(target);
      }
      shared.dismiss(id, how);
    },
    [anchor],
  );

  const hold = useCallback((on: boolean) => setSwiping((count) => count + (on ? 1 : -1)), []);

  return (
    <section
      ref={region}
      className="ui-toaster"
      aria-label={label}
      data-shown={front ? "" : undefined}
    >
      <ol
        className="ui-toast-list"
        onPointerEnter={(event: PointerEvent) => {
          if (event.pointerType === "mouse") setHovering(true);
        }}
        onPointerLeave={(event: PointerEvent) => {
          if (event.pointerType === "mouse") setHovering(false);
        }}
        onPointerDownCapture={() => setPressing(true)}
        onFocus={(event: FocusEvent<HTMLOListElement>) => {
          setFocused(true);
          if (!event.currentTarget.contains(event.relatedTarget))
            cameFrom.current = event.relatedTarget;
        }}
        onBlur={(event: FocusEvent<HTMLOListElement>) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.key} toast={toast} onDismiss={dismiss} onHold={hold} />
        ))}
      </ol>
    </section>
  );
}

interface ToastItemProps {
  toast: Toast;
  onDismiss(id: string, how?: Toast["leaving"]): void;
  onHold(on: boolean): void;
}

const ToastItem = memo(function ToastItem({ toast, onDismiss, onHold }: ToastItemProps) {
  const item = useRef<HTMLLIElement>(null);
  const { id, leaving } = toast;
  const latest = useRef({ onHold, onDismiss });
  latest.current = { onHold, onDismiss };
  // Inserted holding `data-entering`, then let go, so it drops out of the island as it fades in.
  const [entering, setEntering] = useState(true);
  useLayoutEffect(() => {
    item.current?.getBoundingClientRect();
    setEntering(false);
  }, []);

  useEffect(() => {
    const element = item.current;
    if (!element) return;
    let held = false;
    const holding = (on: boolean) => {
      if (held === on) return;
      held = on;
      latest.current.onHold(on);
    };
    const detach = attachToastSwipe(element, {
      holding,
      away() {
        latest.current.onDismiss(id, "swipe");
      },
      gone() {
        holding(false);
        shared.forget(id);
      },
      reducedMotion: () => matches(REDUCED_MOTION),
    });
    return () => {
      detach();
      holding(false);
    };
  }, [id]);

  useEffect(() => {
    if (leaving !== "fade") return;
    return afterMotion([item.current], () => shared.forget(id));
  }, [leaving, id]);

  return (
    <li
      ref={item}
      className="ui-toast"
      data-tone={toast.tone}
      data-entering={entering ? "" : undefined}
      data-leaving={leaving}
      inert={!!leaving}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss(id);
      }}
    >
      <div className="ui-toast-body">
        {(toast.icon || toast.tone !== "neutral") && (
          <Icon
            name={toast.icon ?? (toast.tone === "danger" ? "circle-alert" : "check")}
            className="ui-toast-icon"
          />
        )}
        <div className="ui-toast-text">
          <p className="ui-toast-title">{toast.title}</p>
          {toast.description && <p className="ui-toast-description">{toast.description}</p>}
        </div>
        {toast.action && (
          <Button
            size="sm"
            onClick={() => {
              toast.action?.onAction();
              // An action that shows its follow-up under the same id keeps the toast, changed in place.
              if (
                shared.list().some((other) => other.id === id && !other.leaving && other !== toast)
              )
                return;
              onDismiss(id);
            }}
          >
            {toast.action.label}
          </Button>
        )}
        <IconButton icon="x" size={24} label="Dismiss" onClick={() => onDismiss(id)} />
        {!!toast.details?.length && (
          <DetailLines lines={toast.details} className="ui-toast-details" />
        )}
      </div>
    </li>
  );
});
