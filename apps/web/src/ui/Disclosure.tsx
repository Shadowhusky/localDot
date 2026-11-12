import { clsx } from "clsx";
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type TransitionEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { t } from "../i18n/index.ts";
import { Icon } from "./Icon.tsx";
import { mergeHandlers } from "./merge.ts";
import { pressHandlers } from "./press.ts";

export interface CollapseProps {
  open: boolean;
  id?: string;
  className?: string;
  // Content that arrives or changes size while it is open eases to its new height, as the opening
  // itself does, rather than arriving all at once.
  fit?: boolean;
  children?: ReactNode;
}

// Longer than the fold (--dur-default), so the content stays while it folds away.
const FOLDED = 520;

// Height comes from the grid track, so nothing is measured, unless it is to `fit` its content. The
// content mounts when it opens and leaves once it has folded away, so closed panels hold no heavy
// content (long output, frames).
export function Collapse({ open, id, className, fit = false, children }: CollapseProps) {
  const [mounted, setMounted] = useState(open);
  const [settled, setSettled] = useState(open);
  const panel = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  if (open && !mounted) setMounted(true);
  if (!open && settled) setSettled(false);
  useEffect(() => {
    if (open || !mounted) return;
    const done = window.setTimeout(() => setMounted(false), FOLDED);
    return () => window.clearTimeout(done);
  }, [open, mounted]);
  useLayoutEffect(() => {
    const outer = panel.current;
    const content = inner.current;
    if (!fit || !outer || !content || typeof ResizeObserver === "undefined") return;
    const size = () => {
      outer.style.height = open ? `${content.offsetHeight}px` : "0px";
    };
    size();
    // Not within the observer's delivery: the height resizes what other observers watch, above this.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(size);
    });
    observer.observe(content);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fit, open]);
  return (
    <div
      ref={panel}
      id={id}
      className={clsx("ui-collapse", className)}
      data-fit={fit || undefined}
      data-open={open || undefined}
      data-settled={(open && settled) || undefined}
      inert={!open}
      onTransitionEnd={(event: TransitionEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget && open) setSettled(true);
      }}
    >
      <div ref={inner} className="ui-collapse-inner">
        {mounted && children}
      </div>
    </div>
  );
}

export interface DisclosureProps extends Omit<ComponentProps<"button">, "children" | "onToggle"> {
  summary: ReactNode;
  meta?: ReactNode;
  // A quiet line of text rather than a row: inside a toast, or under a row's name.
  inline?: boolean;
  // A pinned strip whose summary spans several lines, such as a plan's progress.
  strip?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
  panelClassName?: string;
  children?: ReactNode;
}

export function Disclosure({
  summary,
  meta,
  inline = false,
  strip = false,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  panelClassName,
  children,
  ...props
}: DisclosureProps) {
  const panel = useId();
  const [own, setOwn] = useState(defaultOpen);
  const shown = open ?? own;
  const set = (next: boolean) => {
    if (open === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  return (
    <div
      className={clsx("ui-disclosure", className)}
      data-open={shown || undefined}
      data-inline={inline || undefined}
      data-strip={strip || undefined}
    >
      <button
        {...mergeHandlers(props, pressHandlers)}
        type="button"
        className="ui-disclosure-trigger"
        aria-expanded={shown}
        aria-controls={panel}
        onClick={(event) => {
          props.onClick?.(event);
          set(!shown);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          props.onKeyDown?.(event);
          pressHandlers.onKeyDown(event);
          if (event.key === "Escape" && shown) {
            event.stopPropagation();
            set(false);
          }
        }}
      >
        <Icon name="chevron-right" size={12} className="ui-disclosure-chevron" />
        <span className="ui-disclosure-label">
          <span className="ui-disclosure-summary">{summary}</span>{" "}
          {meta !== undefined && <span className="ui-disclosure-meta">{meta}</span>}
        </span>
      </button>
      <Collapse id={panel} open={shown} className={panelClassName}>
        {children}
      </Collapse>
    </div>
  );
}

// A few plain lines behind a quiet Details, such as the parts of a cleanup that couldn't be confirmed.
export function DetailLines({
  lines,
  className,
}: {
  lines: readonly string[];
  className?: string;
}) {
  return (
    <Disclosure inline summary={t`Details`} className={className}>
      <ul className="ui-detail-lines">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Disclosure>
  );
}
