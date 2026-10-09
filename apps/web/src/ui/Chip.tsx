import { clsx } from "clsx";
import type { ComponentProps, MouseEvent } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { joinIds, mergeHandlers } from "./merge.ts";
import { pressHandlers } from "./press.ts";
import { useTooltip } from "./Tooltip.tsx";

export interface ChipProps extends Omit<ComponentProps<"button">, "type"> {
  // Filled for attachments and values, outline for suggestions.
  variant?: "filled" | "outline";
  icon?: IconName;
  // A tooltip that says more than the chip's words.
  hint?: string;
  // Unavailable while set. The chip keeps focus and gives this as its description and tooltip.
  disabledReason?: string;
}

export function Chip({
  variant = "filled",
  icon,
  hint,
  disabledReason,
  className,
  children,
  onClick,
  ...props
}: ChipProps) {
  const { triggerProps, tooltip } = useTooltip({
    content: disabledReason ? (
      <>
        {hint && <span>{hint}</span>}
        <span className="ui-tooltip-reason">{disabledReason}</span>
      </>
    ) : (
      hint
    ),
    description: disabledReason,
    showOnPress: Boolean(disabledReason),
  });
  return (
    <>
      <button
        {...mergeHandlers(props, pressHandlers, triggerProps.handlers)}
        type="button"
        className={clsx("ui-chip", className)}
        data-variant={variant}
        aria-disabled={disabledReason ? true : props["aria-disabled"]}
        aria-describedby={joinIds(props["aria-describedby"], triggerProps["aria-describedby"])}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          if (disabledReason) event.preventDefault();
          else onClick?.(event);
        }}
      >
        {icon && <Icon name={icon} size={14} className="ui-chip-icon" />}
        {children}
      </button>
      {tooltip}
    </>
  );
}
