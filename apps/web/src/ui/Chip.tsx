import { clsx } from "clsx";
import type { ComponentProps } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { mergeHandlers } from "./merge.ts";
import { pressHandlers } from "./press.ts";

export interface ChipProps extends Omit<ComponentProps<"button">, "type"> {
  // Filled for attachments and values, outline for suggestions.
  variant?: "filled" | "outline";
  icon?: IconName;
}

export function Chip({ variant = "filled", icon, className, children, ...props }: ChipProps) {
  return (
    <button
      {...mergeHandlers(props, pressHandlers)}
      type="button"
      className={clsx("ui-chip", className)}
      data-variant={variant}
    >
      {icon && <Icon name={icon} size={14} className="ui-chip-icon" />}
      {children}
    </button>
  );
}
