import { clsx } from "clsx";
import type { ComponentProps, MouseEvent } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { joinIds, mergeHandlers } from "./merge.ts";
import { pressHandlers } from "./press.ts";
import { useTooltip } from "./Tooltip.tsx";

export interface IconButtonProps
  extends Omit<ComponentProps<"button">, "disabled" | "children" | "aria-label"> {
  label: string;
  icon: IconName;
  size?: 24 | 28 | 32 | 36;
  // A primary icon button is the one main action of its group, such as Play: round and filled.
  variant?: "quiet" | "primary";
  kbd?: readonly string[];
  // Unavailable while set. The button keeps focus and gives this as its description and tooltip.
  disabledReason?: string;
}

export function IconButton({
  label,
  icon,
  size = 28,
  variant = "quiet",
  kbd,
  disabledReason,
  type = "button",
  className,
  onClick,
  ...props
}: IconButtonProps) {
  const { triggerProps, tooltip } = useTooltip({
    content: disabledReason ? (
      <>
        <span>{label}</span>
        <span className="ui-tooltip-reason">{disabledReason}</span>
      </>
    ) : (
      label
    ),
    kbd,
    description: disabledReason,
    showOnPress: Boolean(disabledReason),
  });
  return (
    <>
      <button
        {...mergeHandlers(props, pressHandlers, triggerProps.handlers)}
        type={type}
        className={clsx("ui-icon-button", className)}
        data-size={size}
        data-variant={variant === "primary" ? variant : undefined}
        aria-label={label}
        aria-disabled={disabledReason ? true : undefined}
        aria-describedby={joinIds(props["aria-describedby"], triggerProps["aria-describedby"])}
        aria-keyshortcuts={triggerProps["aria-keyshortcuts"] ?? props["aria-keyshortcuts"]}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          if (disabledReason) event.preventDefault();
          else onClick?.(event);
        }}
      >
        <Icon name={icon} />
      </button>
      {tooltip}
    </>
  );
}
