import { clsx } from "clsx";
import {
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { tabbables } from "./focus.ts";
import { LayerPortal, useExit, useLayer, useLeaving } from "./LayerStack.tsx";
import { type Align, place, type Side } from "./position.ts";

export interface AnchoredProps {
  kind: "popover" | "menu";
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
  side?: Side;
  align?: Align;
  // Keeps Tab inside the popup; a menu closes on Tab instead.
  trap: boolean;
  initialFocus(panel: HTMLElement): HTMLElement | undefined;
  // Dims the page behind, as a phone's menu over a busy screen does.
  dim?: boolean;
  panelRef?: RefObject<HTMLDivElement | null>;
  panelProps: HTMLAttributes<HTMLDivElement> & { [data: `data-${string}`]: string | undefined };
  children: ReactNode;
}

// Spread on the control that opens a menu or a popover: it names what opens and whether it is open,
// which also keeps the control lit while it is.
export function triggerProps(popup: "menu" | "dialog", open: boolean) {
  return { "aria-haspopup": popup, "aria-expanded": open } as const;
}

// The popup is inserted holding its starting state (data-placing) with no transition, placed, and
// only then let go, so it grows toward the side it actually opens on. React never sets the attribute
// again, because its value never changes.
export function finishPlacing(element: HTMLElement) {
  if (!element.hasAttribute("data-placing")) return;
  void element.offsetWidth;
  element.removeAttribute("data-placing");
}

// Puts a popup beside its anchor, through the CSSOM so the page's CSP holds.
function put(element: HTMLElement, target: HTMLElement, side: Side, align: Align) {
  // Measure the full content without temporarily expanding the scrollport. Clearing
  // maxHeight clamps scrollTop to zero, so every scroll event used to jump tall menus
  // back to their first item (and a following tap could hit a different choice).
  const naturalHeight = element.scrollHeight + element.offsetHeight - element.clientHeight;
  const found = place({
    anchor: target.getBoundingClientRect(),
    size: { width: element.offsetWidth, height: naturalHeight },
    viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
    side,
    align,
  });
  element.style.top = `${Math.round(found.top)}px`;
  element.style.left = `${Math.round(found.left)}px`;
  element.style.maxHeight = `${Math.floor(found.maxHeight)}px`;
  element.style.transformOrigin = `${Math.round(found.originX)}px ${Math.round(found.originY)}px`;
  element.dataset.side = found.side;
}

// A popup beside its anchor. A transparent catcher lies under it, so a press anywhere else only
// closes it: the press never reaches the control beneath, and a tap's late click has nowhere to go.
export function Anchored(props: AnchoredProps) {
  const root = useRef<HTMLDivElement>(null);
  const { mounted, closing } = useExit(props.open, root);
  const shown = useLeaving(props, closing);
  return mounted ? <AnchoredLayer {...shown} root={root} closing={closing} /> : null;
}

function AnchoredLayer({
  kind,
  onClose,
  anchor,
  side = "bottom",
  align = "start",
  trap,
  initialFocus,
  dim = false,
  panelRef,
  panelProps,
  children,
  root,
  closing,
}: AnchoredProps & { root: RefObject<HTMLDivElement | null>; closing: boolean }) {
  const own = useRef<HTMLDivElement>(null);
  const panel = panelRef ?? own;
  const placement = useRef({ side, align, closing });
  placement.current = { side, align, closing };

  useLayer({
    active: !closing,
    root,
    panel,
    trap,
    modal: false,
    onEscape: onClose,
    initialFocus,
    returnFocus: anchor,
  });

  const update = useRef(() => {
    const element = panel.current;
    const target = anchor.current;
    if (!element || placement.current.closing) return;
    if (target) put(element, target, placement.current.side, placement.current.align);
    finishPlacing(element);
  }).current;

  // After every render: what the popup holds can change its size.
  useLayoutEffect(update);

  useEffect(() => {
    let frame = 0;
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(soon);
    if (panel.current) observer?.observe(panel.current);
    if (anchor.current) observer?.observe(anchor.current);
    window.addEventListener("scroll", soon, { capture: true, passive: true });
    window.addEventListener("resize", soon);
    // The page can move the anchor without resizing it, which no observer reports: checked each
    // frame while open, so the popup never sits off its anchor until the next render.
    let watch = 0;
    let at = "";
    const follow = () => {
      const box = anchor.current?.getBoundingClientRect();
      const now = box ? `${box.left} ${box.top}` : "";
      if (at && now !== at) update();
      at = now;
      watch = requestAnimationFrame(follow);
    };
    watch = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(watch);
      observer?.disconnect();
      window.removeEventListener("scroll", soon, { capture: true });
      window.removeEventListener("resize", soon);
    };
  }, [anchor, panel, update]);

  return (
    <LayerPortal kind={kind} closing={closing} rootRef={root}>
      <div
        className="ui-catcher"
        data-dim={dim || undefined}
        aria-hidden="true"
        onPointerDown={(event) => {
          event.preventDefault();
          if (!closing) onClose();
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div
        {...panelProps}
        ref={panel}
        tabIndex={-1}
        inert={closing}
        data-placing=""
        className={clsx("ui-popup", panelProps.className)}
      >
        {children}
      </div>
    </LayerPortal>
  );
}

export interface PopoverProps {
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
  side?: Side;
  align?: Align;
  // A visible heading names the popover; without one, label does.
  title?: ReactNode;
  label?: string;
  // A panel with a picture in it (an export's preview) takes the wider size.
  size?: "md" | "lg";
  className?: string;
  children: ReactNode;
}

export function Popover({
  title,
  label,
  size = "md",
  className,
  children,
  ...props
}: PopoverProps) {
  const titleId = useId();
  return (
    <Anchored
      {...props}
      kind="popover"
      trap
      initialFocus={(panel) => tabbables(panel)[0]}
      panelProps={{
        role: "dialog",
        "aria-modal": true,
        "aria-label": title ? undefined : label,
        "aria-labelledby": title ? titleId : undefined,
        className: clsx("ui-popover", className),
        "data-size": size,
      }}
    >
      {title && (
        <h2 id={titleId} className="ui-popover-title">
          {title}
        </h2>
      )}
      {children}
    </Anchored>
  );
}
