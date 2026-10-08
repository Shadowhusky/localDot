import { clsx } from "clsx";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const GAP = 8;
const EDGE = 8;
// Longer than --dur-exit, so the fade finishes before the element goes.
const EXIT = 220;

interface Placement {
  side: "top" | "bottom";
  align: "start" | "end";
  matchWidth: boolean;
}

function place(element: HTMLElement, trigger: HTMLElement, { side, align, matchWidth }: Placement) {
  const box = trigger.getBoundingClientRect();
  if (matchWidth) element.style.width = `${Math.round(box.width)}px`;
  const { offsetWidth: width, offsetHeight: height } = element;
  const top = side === "top" ? box.top - GAP - height : box.bottom + GAP;
  const wanted = align === "start" ? box.left : box.right - width;
  const left = Math.min(Math.max(wanted, EDGE), window.innerWidth - EDGE - width);
  element.style.top = `${Math.round(Math.max(EDGE, top))}px`;
  element.style.left = `${Math.round(left)}px`;
  element.style.transformOrigin = `${Math.round(box.left + box.width / 2 - left)}px ${side === "top" ? "100%" : "0"}`;
}

export interface PopoverProps {
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  side?: "top" | "bottom";
  align?: "start" | "end";
  matchWidth?: boolean;
  className?: string;
  children: ReactNode;
}

// Non-modal: an outside press closes it without stealing that press.
export function Popover({
  open,
  onClose,
  anchor,
  label,
  side = "top",
  align = "start",
  matchWidth = false,
  className,
  children,
}: PopoverProps) {
  const popup = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(open);
  const close = useRef(onClose);
  close.current = onClose;
  if (open && !shown) setShown(true);

  useEffect(() => {
    if (open || !shown) return;
    const done = window.setTimeout(() => setShown(false), EXIT);
    return () => window.clearTimeout(done);
  }, [open, shown]);

  useEffect(() => {
    if (!open) return;
    popup.current?.focus({ preventScroll: true });
    const away = (event: Event) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !anchor.current?.contains(target)) close.current();
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      const inside = popup.current?.contains(document.activeElement);
      close.current();
      if (inside) anchor.current?.focus({ preventScroll: true });
    };
    // A phone's toolbar showing or hiding changes only the height: follow the trigger, stay open.
    const width = window.innerWidth;
    const resized = () => {
      if (window.innerWidth !== width) close.current();
      else if (popup.current && anchor.current)
        place(popup.current, anchor.current, { side, align, matchWidth });
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", dismiss, true);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("resize", resized);
    };
  }, [open, anchor, side, align, matchWidth]);

  useLayoutEffect(() => {
    if (shown && popup.current && anchor.current)
      place(popup.current, anchor.current, { side, align, matchWidth });
  });

  if (!shown) return null;
  return createPortal(
    <div
      ref={popup}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={clsx("ui-popover", className)}
      data-side={side}
      data-closing={open ? undefined : ""}
    >
      {children}
    </div>,
    document.body,
  );
}
