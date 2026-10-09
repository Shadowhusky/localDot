import { clsx } from "clsx";
import type { ComponentProps, MouseEvent } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { joinIds, mergeHandlers } from "./merge.ts";
import { pressHandlers } from "./press.ts";
import { Spinner } from "./Spinner.tsx";
import { useTooltip } from "./Tooltip.tsx";

export type ButtonSize = "sm" | "md" | "lg" | "xl" | "xxl";

// Primary is porcelain: the one main action of a surface, never two on screen at once.
export interface ButtonProps extends Omit<ComponentProps<"button">, "disabled"> {
  variant?: "primary" | "secondary" | "quiet" | "destructive";
  size?: ButtonSize;
  icon?: IconName;
  busy?: boolean;
  // Unavailable while set. The button keeps focus and gives this as its description and tooltip.
  disabledReason?: string;
}

const ICON_SIZE = { sm: 14, md: 16, lg: 18, xl: 18, xxl: 20 } as const;

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  busy = false,
  disabledReason,
  type = "button",
  className,
  children,
  onClick,
  ...props
}: ButtonProps) {
  const inactive = busy || Boolean(disabledReason);
  const { triggerProps, tooltip } = useTooltip({
    content: disabledReason,
    description: disabledReason,
    showOnPress: true,
  });
  return (
    <>
      <button
        {...mergeHandlers(props, pressHandlers, triggerProps.handlers)}
        type={type}
        className={clsx("ui-button", className)}
        data-variant={variant}
        data-size={size}
        data-icon={icon ? "" : undefined}
        aria-disabled={inactive || undefined}
        aria-busy={busy || undefined}
        aria-describedby={joinIds(props["aria-describedby"], triggerProps["aria-describedby"])}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          if (inactive) event.preventDefault();
          else onClick?.(event);
        }}
      >
        <span className="ui-button-content">
          {/* Busy, the spinner takes the icon's place and the label stays. */}
          {icon &&
            (busy ? (
              <span className="ui-button-glyph">
                <Spinner size={14} />
              </span>
            ) : (
              <Icon name={icon} size={ICON_SIZE[size]} />
            ))}
          {children}
        </span>
        {busy && !icon && <Spinner className="ui-button-spinner" />}
      </button>
      {tooltip}
    </>
  );
}
