import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef } from "react";
import { tabbables } from "./focus.ts";
import { LayerPortal, useBehind, useExit, useLayer } from "./LayerStack.tsx";
import { PHONE, useMediaQuery } from "./media.ts";
import { finishPlacing } from "./Popover.tsx";
import { place as placeBeside } from "./position.ts";
import { useScrim } from "./scrim.ts";
import { lockScroll } from "./scroll-lock.ts";

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  description?: ReactNode;
  // What the choice is about, as label and value pairs under the description.
  facts?: readonly (readonly [string, ReactNode])[];
  // The control that asked. The dialog grows out of it, and on a wide screen opens beside it.
  anchor?: RefObject<HTMLElement | null>;
  // The choices, the safe one first: it takes focus, so Enter never confirms by accident.
  children: ReactNode;
}

// Beside its anchor on a wide screen; otherwise centred, growing out of the anchor.
function putDialog(element: HTMLElement, target: HTMLElement, beside: boolean) {
  const rect = target.getBoundingClientRect();
  if (beside) element.dataset.anchored = "";
  else delete element.dataset.anchored;
  if (beside) {
    const found = placeBeside({
      anchor: rect,
      size: { width: element.offsetWidth, height: element.offsetHeight },
      viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
      side: "bottom",
      align: "center",
    });
    element.style.top = `${Math.round(found.top)}px`;
    element.style.left = `${Math.round(found.left)}px`;
    element.style.transformOrigin = `${Math.round(found.originX)}px ${Math.round(found.originY)}px`;
    element.dataset.side = found.side;
    return;
  }
  element.style.top = "";
  element.style.left = "";
  const x = rect.left + rect.width / 2 - element.offsetLeft;
  const y = rect.top + rect.height / 2 - element.offsetTop;
  element.style.transformOrigin = `${Math.round(x)}px ${Math.round(y)}px`;
}

// For a destructive, irreversible step only, such as deleting a recording.
export function Dialog(props: DialogProps) {
  const root = useRef<HTMLDivElement>(null);
  const { mounted, closing } = useExit(props.open, root);
  return mounted ? <DialogLayer {...props} root={root} closing={closing} /> : null;
}

function DialogLayer({
  onClose,
  title,
  description,
  facts,
  anchor,
  children,
  root,
  closing,
}: DialogProps & { root: RefObject<HTMLDivElement | null>; closing: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const beside = useMediaQuery(PHONE) === false && anchor !== undefined;
  const scrim = useScrim(() => {
    if (!closing) onClose();
  });
  const entry = useLayer({
    active: !closing,
    root,
    panel,
    trap: true,
    modal: true,
    onEscape: onClose,
    initialFocus: (element) => {
      const actions = element.querySelector<HTMLElement>(".ui-dialog-actions");
      return actions ? tabbables(actions)[0] : undefined;
    },
    returnFocus: anchor,
  });
  const behind = useBehind(entry);

  useEffect(() => lockScroll(), []);

  const position = useRef(() => {});
  position.current = () => {
    const element = panel.current;
    const target = anchor?.current;
    if (!element || closing) return;
    if (target) putDialog(element, target, beside);
    finishPlacing(element);
  };

  useLayoutEffect(() => position.current());

  useEffect(() => {
    const resize = () => position.current();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  return (
    <LayerPortal kind="dialog" closing={closing} rootRef={root}>
      <div className="ui-scrim" aria-hidden="true" {...scrim} />
      <section
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        inert={closing}
        data-placing=""
        className="ui-dialog"
        data-behind={behind ? "" : undefined}
      >
        <h2 id={titleId} className="ui-dialog-title">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="ui-dialog-description">
            {description}
          </p>
        )}
        {facts && (
          <dl className="ui-dialog-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="ui-dialog-actions">{children}</div>
      </section>
    </LayerPortal>
  );
}
