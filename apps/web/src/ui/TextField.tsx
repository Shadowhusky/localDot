import { clsx } from "clsx";
import type { ComponentProps, PointerEvent, ReactNode } from "react";
import { useFieldControl } from "./Field.tsx";

export interface TextFieldProps
  extends Omit<ComponentProps<"input">, "size" | "prefix" | "disabled"> {
  // 32 px, or 36 px inside a sheet; 44 px on a touch screen either way.
  size?: "md" | "lg";
  prefix?: ReactNode;
  suffix?: ReactNode;
}

// A press on the field's padding or an affix lands in the input, as it would on a native field.
function focusInput(event: PointerEvent<HTMLDivElement>) {
  const input = event.currentTarget.querySelector("input");
  if (!input || event.target === input || (event.target as Element).closest("button")) return;
  event.preventDefault();
  input.focus();
}

export function TextField({
  size = "md",
  prefix,
  suffix,
  className,
  type = "text",
  readOnly,
  ...props
}: TextFieldProps) {
  const control = useFieldControl(props);
  const unavailable = Boolean(control.disabledReason);
  return (
    <div
      className={clsx("ui-field-box ui-text-field", className)}
      data-size={size}
      data-invalid={control.invalid ? "" : undefined}
      data-unavailable={unavailable ? "" : undefined}
      onPointerDown={focusInput}
    >
      {prefix !== undefined && (
        <span className="ui-field-affix" aria-hidden="true">
          {prefix}
        </span>
      )}
      <input
        {...props}
        type={type}
        id={control.id}
        className="ui-input"
        readOnly={readOnly || unavailable}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        aria-disabled={unavailable || props["aria-disabled"] || undefined}
      />
      {suffix !== undefined && <span className="ui-field-affix">{suffix}</span>}
    </div>
  );
}
