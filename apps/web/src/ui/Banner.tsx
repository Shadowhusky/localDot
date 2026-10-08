import { clsx } from "clsx";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from "react";
import { announce as speak } from "./Announcer.tsx";
import { canFocus, focusWithoutScroll, tabbableBefore } from "./focus.ts";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";
import type { IconName } from "./icons.ts";

const ICONS: Record<BannerTone, IconName | undefined> = {
  neutral: undefined,
  attention: "circle-alert",
  danger: "circle-alert",
};

export type BannerTone = "neutral" | "attention" | "danger";

export interface BannerProps {
  tone?: BannerTone;
  icon?: IconName;
  title: ReactNode;
  // The detail under the title.
  children?: ReactNode;
  // Small buttons: beside the text when there is room, under it otherwise.
  actions?: ReactNode;
  onDismiss?(): void;
  dismissLabel?: string;
  // Opening and closing slide what follows down and back up, and the banner stays mounted.
  open?: boolean;
  // Read out each time it opens. Leave off for a banner that is part of the page from the start.
  announce?: boolean;
  className?: string;
}

// A message that belongs to one panel, in its flow: a failure to act on, a change to notice.
export function Banner({
  tone = "neutral",
  icon = ICONS[tone],
  title,
  children,
  actions,
  onDismiss,
  dismissLabel = "Dismiss",
  open = true,
  announce = false,
  className,
}: BannerProps) {
  const id = useId();
  const reveal = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const cameFrom = useRef<Element | null>(null);

  useEffect(() => {
    const element = reveal.current;
    if (!element) return;
    const onFocusIn = (event: FocusEvent) => {
      const from = event.relatedTarget;
      if (!(from instanceof Node) || !element.contains(from))
        cameFrom.current = from instanceof Element ? from : null;
    };
    element.addEventListener("focusin", onFocusIn);
    return () => element.removeEventListener("focusin", onFocusIn);
  }, []);

  // Closing while it holds focus, it gives focus back to where it came from, or to the control
  // before it, and only then is made inert, so focus never falls to the page.
  useLayoutEffect(() => {
    const element = reveal.current;
    if (!element) return;
    if (!open && element.contains(document.activeElement)) {
      const origin = element.contains(cameFrom.current) ? null : cameFrom.current;
      const target = canFocus(origin) ? origin : tabbableBefore(element);
      if (target) focusWithoutScroll(target);
    }
    element.toggleAttribute("inert", !open);
  }, [open]);

  useEffect(() => {
    if (!open || !announce) return;
    const parts = box.current?.querySelectorAll(".ui-banner-title, .ui-banner-detail") ?? [];
    const text = [...parts].map((part) => part.textContent?.trim()).filter(Boolean);
    if (text.length > 0) speak(`banner ${id}`, text.join(". "));
  }, [open, announce, id]);

  return (
    <div
      ref={reveal}
      className={clsx("ui-banner-reveal", className)}
      data-open={open ? "" : undefined}
    >
      <div className="ui-banner-clip">
        <div ref={box} className="ui-banner" data-tone={tone}>
          {icon && <Icon name={icon} className="ui-banner-icon" />}
          <div className="ui-banner-text">
            <p className="ui-banner-title">{title}</p>
            {children && <div className="ui-banner-detail">{children}</div>}
          </div>
          {actions && <div className="ui-banner-actions">{actions}</div>}
          {onDismiss && (
            <IconButton
              icon="x"
              size={24}
              label={dismissLabel}
              className="ui-banner-close"
              onClick={onDismiss}
            />
          )}
        </div>
      </div>
    </div>
  );
}
