import { clsx } from "clsx";
import type { ComponentProps, MouseEvent } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { joinIds, mergeHandlers } from "./merge.ts";
import { pressHandlers } from "./press.ts";
import { useTooltip } from "./Tooltip.tsx";

export type IconButtonSize = 24 | 28 | 32 | 36 | 44;

const ICON_SIZE = { 24: 14, 28: 16, 32: 18, 36: 18, 44: 22 } as const;

export interface IconButtonProps
  extends Omit<ComponentProps<"button">, "disabled" | "children" | "aria-label"> {
  label: string;
  icon: IconName;
  size?: IconButtonSize;
  // Quiet draws only its icon, filled sits on a control face, glass lives on the island over the
  // picture. Primary is a porcelain disc for the one main action of its group, such as Send or Play.
  variant?: "quiet" | "filled" | "glass" | "primary";
  round?: boolean;
  // An amber point at the corner: something behind this button needs you.
  attention?: boolean;
  kbd?: readonly string[];
  // Unavailable while set. The button keeps focus and gives this as its description and tooltip.
  disabledReason?: string;
}

export function IconButton({
  label,
  icon,
  size = 28,
  variant = "quiet",
  round = false,
  attention = false,
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
        data-variant={variant === "quiet" ? undefined : variant}
        data-round={round ? "" : undefined}
        aria-label={label}
        aria-disabled={disabledReason ? true : undefined}
        aria-describedby={joinIds(props["aria-describedby"], triggerProps["aria-describedby"])}
        aria-keyshortcuts={triggerProps["aria-keyshortcuts"] ?? props["aria-keyshortcuts"]}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          if (disabledReason) event.preventDefault();
          else onClick?.(event);
        }}
      >
        <Icon name={icon} size={ICON_SIZE[size]} />
        {attention && <span className="ui-icon-button-attention" aria-hidden="true" />}
      </button>
      {tooltip}
    </>
  );
}
