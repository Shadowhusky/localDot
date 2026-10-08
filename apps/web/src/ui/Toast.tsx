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
import { afterMotion } from "./finished.ts";
import { canFocus, focusWithoutScroll, tabbables } from "./focus.ts";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import { matches, REDUCED_MOTION } from "./media.ts";
import { attachToastSwipe } from "./toast-swipe.ts";
import { createToasts, type Toast, type ToastOptions } from "./toasts.ts";

// The stack shows the front toast and the edges of two behind it; the rest wait their turn.
const VISIBLE = 3;
// After a press on the stack that makes no click (a swipe, a scroll), it is let go this much later.
const PRESS_CLICK_WAIT = 300;
// Below the anchor, between toasts laid out in a column, and peeking out under the one in front.
const ANCHOR_GAP = 8;
const GAP = 8;
const PEEK = 8;
// Each step back is this much narrower, and lighter by this much of the text colour.
const RECEDE = 0.05;
const VEIL = 0.07;

const shared = createToasts();

function bodyOf(item: HTMLLIElement | undefined): HTMLElement | null {
  return item?.querySelector<HTMLElement>(":scope > .ui-toast-body") ?? null;
}

export function showToast(options: ToastOptions): string {
  return shared.show(options);
}

export function dismissToast(id: string): void {
  shared.dismiss(id);
}

export interface ToasterProps {
  // The toasts hang this far below it, centred on it, in the box both share.
  anchor: RefObject<HTMLElement | null>;
  label?: string;
}

// Where the stack sits: under the anchor, in the anchor's own positioned box, out of the flow. The
// anchor can move without changing size, so while any toast is up it is measured every frame.
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

// Front first: in front, each at its own height; behind it, each the front's height, peeking out
// below it and receding, its words covered; laid out, a column at each one's own height.
function arrange(heights: number[], expanded: boolean) {
  const front = heights[0] ?? 0;
  let y = 0;
  const places = heights.map((height, depth) => {
    if (expanded) {
      const place = { y, scale: 1, height, veil: 0, covered: false };
      y += height + GAP;
      return place;
    }
    if (depth === 0) return { y: 0, scale: 1, height, veil: 0, covered: false };
    const scale = 1 - depth * RECEDE;
    return {
      y: front * (1 - scale) + depth * PEEK,
      scale,
      height: front,
      veil: depth * VEIL,
      covered: true,
    };
  });
  const last = places.at(-1);
  const extent = expanded ? Math.max(0, y - GAP) : last ? last.y + last.height * last.scale : 0;
  return { places, extent };
}

export function Toaster({ anchor, label = "Notifications" }: ToasterProps) {
  const toasts = useSyncExternalStore(shared.subscribe, shared.list, shared.list);
  const region = useRef<HTMLElement>(null);
  // By each toast's key, so an element still leaving never stands in for its toast come back.
  const items = useRef(new Map<string, HTMLLIElement>());
  const settled = useRef(new Set<string>());
  const cameFrom = useRef<Element | null>(null);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [swiping, setSwiping] = useState(0);
  const [pressing, setPressing] = useState(false);
  const held = hovering || focused || pinned || swiping > 0 || pressing;

  // While the stack is held, the toasts on it keep their places, so nothing moves under a pointer or
  // a finger: one that comes meanwhile is read out at once and joins the stack when it is let go.
  const live = toasts.filter((toast) => !toast.leaving);
  const [kept, setKept] = useState<readonly string[] | null>(null);
  if (held && !kept) setKept(live.slice(0, VISIBLE).map((toast) => toast.id));
  if (!held && kept) setKept(null);
  const keptLive = kept?.flatMap((id) => live.find((toast) => toast.id === id) ?? []) ?? [];
  const shown = keptLive.length > 0 ? keptLive : live.slice(0, VISIBLE);
  const depthOf = new Map(shown.map((toast, depth) => [toast.id, depth]));
  const rendered = toasts.filter((toast) => toast.leaving || depthOf.has(toast.id));
  const expanded = shown.length > 1 && (hovering || focused || pinned);
  const latest = useRef({ toasts, shown, expanded });
  latest.current = { toasts, shown, expanded };
  useAnchoredTo(anchor, region, rendered.length > 0);

  const layout = useCallback(() => {
    const { shown: front, expanded: open } = latest.current;
    const heights = front.map((toast) => bodyOf(items.current.get(toast.key))?.offsetHeight ?? 0);
    const { places, extent } = arrange(heights, open);
    front.forEach((toast, depth) => {
      const item = items.current.get(toast.key);
      const place = places[depth];
      if (!item || !place) return;
      item.style.setProperty("--_y", `${place.y}px`);
      item.style.setProperty("--_scale", `${place.scale}`);
      item.style.setProperty("--_height", `${place.height}px`);
      item.style.setProperty("--_veil", `${place.veil}`);
      item.style.setProperty("--_z", `${VISIBLE - depth}`);
      item.toggleAttribute("data-covered", place.covered);
      if (item.hasAttribute("data-entering")) {
        item.getBoundingClientRect();
        item.removeAttribute("data-entering");
        settled.current.add(toast.key);
      }
    });
    region.current?.style.setProperty("--_extent", `${extent}px`);
  }, []);

  useLayoutEffect(layout);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(layout);
    for (const item of items.current.values()) {
      const body = bodyOf(item);
      if (body) observer.observe(body);
    }
    return () => observer.disconnect();
  });

  useEffect(() => {
    shared.hold("toaster", held);
    return () => shared.hold("toaster", false);
  }, [held]);

  // A press holds the stack until the click it makes on the stack has been handled, or until a
  // moment after a press that makes none there.
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

  // A tap that opened the stack is undone by a press anywhere else.
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node) || !region.current?.contains(event.target))
        setPinned(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [pinned]);

  useEffect(() => {
    if (shown.length < 2) setPinned(false);
  }, [shown.length]);

  // Focus inside a toast that goes moves to the next one in front, if there is one, and otherwise
  // back to where it came into the stack from, or to the anchor.
  const dismiss = useCallback(
    (id: string, how?: Toast["leaving"]) => {
      const key = latest.current.toasts.find((toast) => toast.id === id && !toast.leaving)?.key;
      const leaving = key === undefined ? undefined : items.current.get(key);
      if (leaving?.contains(document.activeElement)) {
        const next = latest.current.shown.find((toast) => toast.id !== id);
        const inStack = next && tabbables(items.current.get(next.key) ?? leaving).at(-1);
        const origin = region.current?.contains(cameFrom.current) ? null : cameFrom.current;
        const target = [inStack, origin].find(canFocus) ?? anchorFocus(anchor.current);
        if (target) focusWithoutScroll(target);
      }
      shared.dismiss(id, how);
    },
    [anchor],
  );

  const hold = useCallback((on: boolean) => setSwiping((count) => count + (on ? 1 : -1)), []);

  // A touch has no hover, so a tap on the stack opens it out, and another closes it.
  const pointer = useRef("mouse");
  const tap = useCallback(() => {
    if (pointer.current !== "mouse" && latest.current.shown.length > 1) setPinned((open) => !open);
  }, []);

  const register = useCallback((key: string, element: HTMLLIElement | null) => {
    if (element) items.current.set(key, element);
    else {
      items.current.delete(key);
      settled.current.delete(key);
    }
  }, []);

  return (
    <section
      ref={region}
      className="ui-toaster"
      aria-label={label}
      data-expanded={expanded ? "" : undefined}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a tap opens the stack out for touch, where there is no hover; focus does the same from the keyboard. */}
      <ol
        className="ui-toast-list"
        onPointerEnter={(event: PointerEvent) => {
          if (event.pointerType === "mouse") setHovering(true);
        }}
        onPointerLeave={(event: PointerEvent) => {
          if (event.pointerType === "mouse") setHovering(false);
        }}
        onPointerDownCapture={(event: PointerEvent) => {
          pointer.current = event.pointerType;
          setPressing(true);
        }}
        onClick={(event) => {
          if (!(event.target instanceof Element) || !event.target.closest("button")) tap();
        }}
        onFocus={(event: FocusEvent<HTMLOListElement>) => {
          setFocused(true);
          if (!event.currentTarget.contains(event.relatedTarget))
            cameFrom.current = event.relatedTarget;
        }}
        onBlur={(event: FocusEvent<HTMLOListElement>) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        {rendered.map((toast) => {
          const depth = depthOf.get(toast.id);
          return (
            <ToastItem
              key={toast.key}
              toast={toast}
              entering={
                settled.current.has(toast.key) ? undefined : depth === 0 ? "front" : "behind"
              }
              interactive={!toast.leaving && (depth === 0 || expanded)}
              register={register}
              onDismiss={dismiss}
              onHold={hold}
            />
          );
        })}
      </ol>
    </section>
  );
}

interface ToastItemProps {
  toast: Toast;
  entering?: "front" | "behind";
  interactive: boolean;
  register(key: string, element: HTMLLIElement | null): void;
  onDismiss(id: string, how?: Toast["leaving"]): void;
  onHold(on: boolean): void;
}

const ToastItem = memo(function ToastItem({
  toast,
  entering,
  interactive,
  register,
  onDismiss,
  onHold,
}: ToastItemProps) {
  const item = useRef<HTMLLIElement>(null);
  const { id, key, leaving } = toast;
  const latest = useRef({ onHold, onDismiss });
  latest.current = { onHold, onDismiss };

  const ref = useCallback(
    (element: HTMLLIElement | null) => {
      item.current = element;
      register(key, element);
    },
    [key, register],
  );

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
      ref={ref}
      className="ui-toast"
      data-tone={toast.tone}
      data-entering={entering}
      data-leaving={leaving}
      inert={!interactive}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss(id);
      }}
    >
      <div className="ui-toast-body">
        {toast.tone !== "neutral" && (
          <Icon
            name={toast.tone === "danger" ? "circle-alert" : "check"}
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
              onDismiss(id);
              toast.action?.onAction();
            }}
          >
            {toast.action.label}
          </Button>
        )}
        <IconButton icon="x" size={24} label="Dismiss" onClick={() => onDismiss(id)} />
      </div>
    </li>
  );
});
