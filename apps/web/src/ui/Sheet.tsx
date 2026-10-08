import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./Button.tsx";
import { canFocus, firstField, focusWithoutScroll } from "./focus.ts";
import { IconButton } from "./IconButton.tsx";
import { LayerPortal, useBehind, useExit, useLayer } from "./LayerStack.tsx";
import { matches, PHONE, REDUCED_MOTION, useMediaQuery } from "./media.ts";
import { useScrim } from "./scrim.ts";
import { lockScroll } from "./scroll-lock.ts";
import { attachSheetDrag } from "./sheet-drag.ts";

// Longer than the slowest exit (--dur-sheet), so the sheet is gone from view before it unmounts.
const EXIT = 320;

export interface SheetProps {
  open: boolean;
  // Called once a dismissal is allowed; with unsaved changes, only after the user chose Discard.
  onClose(): void;
  title: ReactNode;
  description?: ReactNode;
  // A side panel on wide screens and a bottom sheet on phones, unless one is asked for.
  side?: "auto" | "inspector" | "bottom";
  // While set, Escape, the close button, the dim area and a swipe ask before closing.
  dirty?: boolean;
  // A modal sheet dims the page and keeps focus. A non-modal one sits beside the page, which stays
  // live; Escape and the close button still close it.
  modal?: boolean;
  // Where focus goes back to when the sheet closes; by default what had it before opening.
  returnFocus?: RefObject<HTMLElement | null>;
  closeLabel?: string;
  footer?: ReactNode;
  children: ReactNode;
}

export function Sheet(props: SheetProps) {
  const { mounted, closing } = useExit(props.open, EXIT);
  return mounted ? <SheetLayer {...props} closing={closing} /> : null;
}

function SheetLayer({
  onClose,
  title,
  description,
  side = "auto",
  dirty = false,
  modal = true,
  returnFocus,
  closeLabel = "Close",
  footer,
  children,
  closing,
}: SheetProps & { closing: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const resume = useRef<Element | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const promptId = useId();
  const phone = useMediaQuery(PHONE);
  const placement = side === "auto" ? (phone ? "bottom" : "inspector") : side;
  const [asking, setAsking] = useState(false);
  const latest = useRef({ dirty, asking, onClose, closing });
  latest.current = { dirty, asking, onClose, closing };

  const requestClose = useCallback(() => {
    const now = latest.current;
    if (now.closing) return;
    if (!now.dirty) return now.onClose();
    if (!now.asking) resume.current = document.activeElement;
    setAsking(true);
  }, []);

  const keepEditing = useCallback(() => {
    setAsking(false);
    const target = resume.current;
    resume.current = null;
    if (canFocus(target) && panel.current?.contains(target) && target !== keep.current)
      focusWithoutScroll(target);
    else if (panel.current) focusWithoutScroll(panel.current);
  }, []);

  const entry = useLayer({
    active: !closing,
    root,
    panel,
    trap: modal,
    modal,
    onEscape: () => (latest.current.asking ? keepEditing() : requestClose()),
    // A phone keeps its keyboard down until a field is chosen.
    initialFocus: (element) => (matches("(pointer: coarse)") ? undefined : firstField(element)),
    returnFocus,
  });
  const behind = useBehind(entry);
  const scrim = useScrim(requestClose);

  useEffect(() => (modal ? lockScroll() : undefined), [modal]);

  useEffect(() => {
    if (!dirty) setAsking(false);
  }, [dirty]);

  useLayoutEffect(() => {
    if (asking) keep.current?.focus();
  }, [asking]);

  // The edges show a hairline only while content runs under them.
  useEffect(() => {
    const scroller = body.current;
    const sheet = panel.current;
    if (!scroller || !sheet) return;
    const mark = () => {
      const { scrollTop, scrollHeight, clientHeight } = scroller;
      sheet.toggleAttribute("data-under-top", scrollTop > 0);
      sheet.toggleAttribute("data-under-bottom", scrollTop + clientHeight < scrollHeight - 1);
    };
    mark();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(mark);
    observer?.observe(scroller);
    for (const child of scroller.children) observer?.observe(child);
    scroller.addEventListener("scroll", mark, { passive: true });
    return () => {
      observer?.disconnect();
      scroller.removeEventListener("scroll", mark);
    };
  }, []);

  useEffect(() => {
    const sheet = panel.current;
    if (placement !== "bottom" || closing || !sheet) return;
    return attachSheetDrag({
      panel: sheet,
      scrim: scrimRef.current,
      body: body.current,
      allowDismiss: () => {
        if (!latest.current.dirty) return true;
        requestClose();
        return false;
      },
      close: () => latest.current.onClose(),
      reducedMotion: () => matches(REDUCED_MOTION),
    });
  }, [placement, closing, requestClose]);

  return (
    <LayerPortal kind="sheet" closing={closing} rootRef={root} className="ui-sheet-layer">
      {modal && <div ref={scrimRef} className="ui-scrim" aria-hidden="true" {...scrim} />}
      <section
        ref={panel}
        role="dialog"
        aria-modal={modal}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        inert={closing}
        className="ui-sheet"
        data-side={placement}
        data-modal={modal ? "" : undefined}
        data-behind={behind ? "" : undefined}
      >
        <div className="ui-sheet-handle">
          {placement === "bottom" && <div className="ui-sheet-grabber" aria-hidden="true" />}
          <header className="ui-sheet-header">
            <div className="ui-sheet-heading">
              <h2 id={titleId} className="ui-sheet-title">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="ui-sheet-description">
                  {description}
                </p>
              )}
            </div>
            <IconButton label={closeLabel} icon="x" onClick={requestClose} />
          </header>
        </div>
        <div ref={body} className="ui-sheet-body">
          {children}
        </div>
        {footer && (
          <footer className="ui-sheet-footer" inert={asking}>
            {footer}
          </footer>
        )}
        <fieldset
          aria-labelledby={promptId}
          className="ui-sheet-prompt"
          data-shown={asking ? "" : undefined}
          inert={!asking}
        >
          <p id={promptId} className="ui-sheet-prompt-text">
            Discard unsaved changes?
          </p>
          <div className="ui-sheet-prompt-actions">
            <Button ref={keep} variant="primary" onClick={keepEditing}>
              Keep editing
            </Button>
            <Button onClick={() => latest.current.onClose()}>Discard</Button>
          </div>
        </fieldset>
      </section>
    </LayerPortal>
  );
}
