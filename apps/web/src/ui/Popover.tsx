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

export interface PopoverProps {
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  side?: "top" | "bottom";
  align?: "start" | "end";
  // As wide as its trigger, like a menu that belongs to a bar.
  matchWidth?: boolean;
  className?: string;
  children: ReactNode;
}

// Non-modal and anchored: it grows out of its trigger, takes focus while open, and gives it back on
// Escape. An outside press closes it without stealing that press.
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
    const lost = () => close.current();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", dismiss, true);
    window.addEventListener("resize", lost);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("resize", lost);
    };
  }, [open, anchor]);

  useLayoutEffect(() => {
    const element = popup.current,
      trigger = anchor.current;
    if (!shown || !element || !trigger) return;
    const box = trigger.getBoundingClientRect();
    if (matchWidth) element.style.width = `${Math.round(box.width)}px`;
    const { offsetWidth: width, offsetHeight: height } = element;
    const top = side === "top" ? box.top - GAP - height : box.bottom + GAP;
    const wanted = align === "start" ? box.left : box.right - width;
    const left = Math.min(Math.max(wanted, EDGE), window.innerWidth - EDGE - width);
    element.style.top = `${Math.round(Math.max(EDGE, top))}px`;
    element.style.left = `${Math.round(left)}px`;
    element.style.transformOrigin = `${Math.round(box.left + box.width / 2 - left)}px ${side === "top" ? "100%" : "0"}`;
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
