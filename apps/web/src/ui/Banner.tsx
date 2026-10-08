import { clsx } from "clsx";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { announce as speak } from "./Announcer.tsx";
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
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !announce) return;
    const parts = box.current?.querySelectorAll(".ui-banner-title, .ui-banner-detail") ?? [];
    const text = [...parts].map((part) => part.textContent?.trim()).filter(Boolean);
    if (text.length > 0) speak(`banner ${id}`, text.join(". "));
  }, [open, announce, id]);

  return (
    <div
      className={clsx("ui-banner-reveal", className)}
      data-open={open ? "" : undefined}
      inert={!open}
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
