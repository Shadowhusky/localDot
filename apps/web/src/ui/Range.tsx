import type { ComponentProps } from "react";
import { useTooltip } from "./Tooltip.tsx";

// Native seeking keeps arrow keys, touch dragging and assistive technology on the same value.
export function Range({
  label,
  disabledReason,
  onValueChange,
  ...props
}: Omit<ComponentProps<"input">, "type" | "disabled" | "onChange" | "aria-label"> & {
  label: string;
  disabledReason?: string;
  onValueChange(value: number): void;
}) {
  const { triggerProps, tooltip } = useTooltip({
    content: disabledReason ?? label,
    description: disabledReason,
    showOnPress: !!disabledReason,
  });
  return (
    <>
      <input
        {...props}
        {...triggerProps.handlers}
        type="range"
        aria-label={label}
        disabled={!!disabledReason}
        aria-describedby={triggerProps["aria-describedby"]}
        onChange={(event) => onValueChange(Number(event.target.value))}
      />
      {tooltip}
    </>
  );
}
