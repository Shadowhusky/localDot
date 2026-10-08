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
import { afterMotion } from "./finished.ts";
import { canFocus, firstField, focusWithoutScroll } from "./focus.ts";
import { IconButton } from "./IconButton.tsx";
import { LayerPortal, useBehind, useExit, useLayer } from "./LayerStack.tsx";
import { matches, PHONE, REDUCED_MOTION, useMediaQuery } from "./media.ts";
import { useScrim } from "./scrim.ts";
import { lockScroll } from "./scroll-lock.ts";
import { attachSheetDrag } from "./sheet-drag.ts";

const CURRENT_BODY = ".ui-sheet-page:not([data-held], [data-leaving]) > .ui-sheet-body";

// A phone keeps its keyboard down until a field is chosen.
function fieldFor(element: HTMLElement): HTMLElement | undefined {
  return matches("(pointer: coarse)") ? undefined : firstField(element);
}

function pageOf(sheet: HTMLElement | null, key: string): HTMLElement | null {
  return (
    sheet?.querySelector<HTMLElement>(`.ui-sheet-page[data-page="${CSS.escape(key)}"]`) ?? null
  );
}

export interface SheetBack {
  // Names the page it goes back to.
  label: string;
  onBack(): void;
}

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
  // live; the close button, and Escape pressed inside the sheet, still close it. By default an
  // inspector sits beside the page, so the HUD's Stop and approvals stay in reach, and a bottom sheet,
  // which covers a phone's screen, is modal.
  modal?: boolean;
  // Where focus goes back to when the sheet closes; by default what had it before opening.
  returnFocus?: RefObject<HTMLElement | null>;
  closeLabel?: string;
  // Names the page on show. Changing it slides the new page over the old one: in from the right when
  // it has a Back, back from the left when it is the one the Back led to.
  page?: string;
  back?: SheetBack;
  footer?: ReactNode;
  children: ReactNode;
}

interface PageView {
  key: string;
  title: ReactNode;
  description?: ReactNode;
  back?: SheetBack;
  footer?: ReactNode;
  children: ReactNode;
  direction?: "forward" | "back";
}

export function Sheet(props: SheetProps) {
  const root = useRef<HTMLDivElement>(null);
  const { mounted, closing } = useExit(props.open, root);
  return mounted ? <SheetLayer {...props} root={root} closing={closing} /> : null;
}

function SheetLayer({
  onClose,
  title,
  description,
  side = "auto",
  dirty = false,
  modal: asked,
  returnFocus,
  closeLabel = "Close",
  page = "main",
  back,
  footer,
  children,
  root,
  closing,
}: SheetProps & { root: RefObject<HTMLDivElement | null>; closing: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const resume = useRef<Element | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const promptId = useId();
  const phone = useMediaQuery(PHONE);
  const placement = side === "auto" ? (phone ? "bottom" : "inspector") : side;
  const modal = asked ?? placement === "bottom";
  const [asking, setAsking] = useState(false);
  const latest = useRef({ dirty, asking, onClose, closing });
  latest.current = { dirty, asking, onClose, closing };

  const current: PageView = { key: page, title, description, back, footer, children };
  const shownRef = useRef(current);
  const [shown, setShown] = useState<{ key: string; direction?: PageView["direction"] }>({
    key: page,
  });
  // The pages a nested page was opened from stay mounted under it, out of sight and inert, so Back
  // finds each as it was: its state, its scroll, and the row that led on (kept in openers).
  const [held, setHeld] = useState<PageView[]>([]);
  const [leaving, setLeaving] = useState<PageView[]>([]);
  const openers = useRef(new Map<string, Element | null>());
  if (shown.key !== page) {
    const before = shownRef.current;
    const at = held.findIndex((view) => view.key === page);
    const direction = at >= 0 ? "back" : "forward";
    setShown({ key: page, direction });
    if (direction === "forward") {
      openers.current.set(before.key, document.activeElement);
      setHeld([...held.filter((view) => view.key !== before.key), { ...before, direction }]);
      setLeaving(leaving.filter((view) => view.key !== page));
    } else {
      setHeld(held.slice(0, at));
      setLeaving([
        ...leaving.filter((view) => view.key !== page && view.key !== before.key),
        { ...before, direction },
      ]);
    }
  }
  current.direction = shown.key === page ? shown.direction : undefined;
  useLayoutEffect(() => {
    shownRef.current = current;
  });

  // Pages keep the order they were first shown in, so none moves in the DOM, which would drop its
  // scroll position and focus. A render that is about to restart with a new page leaves it alone.
  const order = useRef<string[]>([]);
  const views = [...held, ...leaving, current];
  if (shown.key === page) {
    for (const view of views) if (!order.current.includes(view.key)) order.current.push(view.key);
    order.current = order.current.filter((key) => views.some((view) => view.key === key));
  }
  views.sort((a, b) => order.current.indexOf(a.key) - order.current.indexOf(b.key));

  useEffect(() => {
    if (leaving.length === 0) return;
    const sheet = panel.current;
    return afterMotion(
      leaving.map((view) => pageOf(sheet, view.key)),
      () => setLeaving([]),
    );
  }, [leaving]);

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
    beside: !modal,
    onEscape: () => (latest.current.asking ? keepEditing() : requestClose()),
    initialFocus: fieldFor,
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

  // A new page takes focus from the one that slid away: its first field, else its Back. A page Back
  // returns to gives it to the row that led on from it.
  const firstPage = useRef(true);
  useLayoutEffect(() => {
    if (firstPage.current) {
      firstPage.current = false;
      return;
    }
    const view = pageOf(panel.current, shown.key);
    if (!view) return;
    const opener = openers.current.get(shown.key);
    openers.current.delete(shown.key);
    const target =
      shown.direction === "back" && canFocus(opener) && view.contains(opener)
        ? opener
        : (fieldFor(view) ?? view.querySelector<HTMLElement>(".ui-sheet-back"));
    focusWithoutScroll(target ?? (panel.current as HTMLElement));
  }, [shown]);

  // A bottom sheet eases between the heights of the pages it moves between.
  const sized = useRef({ key: page, height: 0 });
  useLayoutEffect(() => {
    const sheet = panel.current;
    if (!sheet) return;
    const before = sized.current;
    const after = sheet.offsetHeight;
    sized.current = { key: shown.key, height: after };
    if (before.key === shown.key || placement !== "bottom" || !before.height) return;
    if (before.height === after || matches(REDUCED_MOTION)) return;
    sheet.style.height = `${before.height}px`;
    void sheet.offsetHeight;
    sheet.dataset.resizing = "";
    sheet.style.height = `${after}px`;
    return afterMotion(
      [sheet],
      () => {
        sheet.style.removeProperty("height");
        delete sheet.dataset.resizing;
      },
      false,
    );
  }, [shown.key, placement]);

  useEffect(() => {
    const sheet = panel.current;
    if (!sheet || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (sheet.dataset.resizing === undefined) sized.current.height = sheet.offsetHeight;
    });
    observer.observe(sheet);
    return () => observer.disconnect();
  }, []);

  // The edges show a hairline only while content runs under them.
  useEffect(() => {
    const sheet = panel.current;
    const scroller = pageOf(sheet, shown.key)?.querySelector<HTMLElement>(".ui-sheet-body");
    if (!scroller || !sheet) return;
    scroller.style.setProperty("--_gutter", `${scroller.offsetWidth - scroller.clientWidth}px`);
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
  }, [shown.key]);

  useEffect(() => {
    const sheet = panel.current;
    if (placement !== "bottom" || closing || !sheet) return;
    return attachSheetDrag({
      panel: sheet,
      scrim: scrimRef.current,
      body: () => sheet.querySelector<HTMLElement>(CURRENT_BODY),
      allowDismiss: () => {
        if (!latest.current.dirty) return true;
        requestClose();
        return false;
      },
      close: () => latest.current.onClose(),
      reducedMotion: () => matches(REDUCED_MOTION),
    });
  }, [placement, closing, requestClose]);

  const pageProps = { closeLabel, onClose: requestClose, asking };
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
        {placement === "bottom" && (
          <div className="ui-sheet-handle">
            <div className="ui-sheet-grabber" aria-hidden="true" />
          </div>
        )}
        <div className="ui-sheet-pages">
          {/* One keyed list, so a page that is held or leaving keeps its instance and state. */}
          {views.map((view) => (
            <SheetPage
              key={view.key}
              view={view}
              held={held.includes(view)}
              leaving={leaving.includes(view)}
              titleId={view === current ? titleId : undefined}
              descriptionId={view === current ? descriptionId : undefined}
              {...pageProps}
            />
          ))}
        </div>
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

interface SheetPageProps {
  view: PageView;
  held: boolean;
  leaving: boolean;
  titleId?: string;
  descriptionId?: string;
  closeLabel: string;
  onClose(): void;
  asking: boolean;
}

// A page keeps its key while it is held or slides away, so what it holds keeps its state.
function SheetPage({
  view,
  held,
  leaving,
  titleId,
  descriptionId,
  closeLabel,
  onClose,
  asking,
}: SheetPageProps) {
  return (
    <div
      className="ui-sheet-page"
      data-page={view.key}
      data-held={held ? "" : undefined}
      data-leaving={leaving ? "" : undefined}
      data-direction={view.direction}
      inert={held || leaving}
    >
      <header className="ui-sheet-header ui-sheet-handle">
        <div className="ui-sheet-heading">
          {view.back && (
            <Button
              variant="quiet"
              size="sm"
              icon="chevron-left"
              className="ui-sheet-back"
              onClick={view.back.onBack}
            >
              {view.back.label}
            </Button>
          )}
          <h2 id={titleId} className="ui-sheet-title">
            {view.title}
          </h2>
          {view.description && (
            <p id={descriptionId} className="ui-sheet-description">
              {view.description}
            </p>
          )}
        </div>
        <IconButton label={closeLabel} icon="x" onClick={onClose} />
      </header>
      <div className="ui-sheet-body">{view.children}</div>
      {view.footer && (
        <footer className="ui-sheet-footer" inert={asking}>
          {view.footer}
        </footer>
      )}
    </div>
  );
}
