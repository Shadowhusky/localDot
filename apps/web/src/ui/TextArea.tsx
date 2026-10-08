import { clsx } from "clsx";
import { type ComponentProps, type CSSProperties, useLayoutEffect, useRef } from "react";
import { useFieldControl } from "./Field.tsx";

const sizesItself = () =>
  typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content") === true;

export interface TextAreaProps extends Omit<ComponentProps<"textarea">, "rows" | "disabled"> {
  // It grows with its text from one line up to this many, then scrolls.
  maxRows?: number;
}

export function TextArea({ maxRows = 8, className, readOnly, style, ...props }: TextAreaProps) {
  const control = useFieldControl(props);
  const unavailable = Boolean(control.disabledReason);
  const own = useRef<HTMLTextAreaElement>(null);

  // Where the browser cannot size a field to its content, measure it after each change.
  useLayoutEffect(() => {
    const area = own.current;
    if (!area || sizesItself()) return;
    const fit = () => {
      area.style.height = "auto";
      const edges = area.offsetHeight - area.clientHeight;
      area.style.height = `${area.scrollHeight + edges}px`;
    };
    fit();
    area.addEventListener("input", fit);
    return () => area.removeEventListener("input", fit);
  });

  return (
    <textarea
      {...props}
      ref={own}
      rows={1}
      id={control.id}
      className={clsx("ui-field-box ui-text-area", className)}
      style={{ ...style, "--_rows": maxRows } as CSSProperties}
      readOnly={readOnly || unavailable}
      data-invalid={control.invalid ? "" : undefined}
      data-unavailable={unavailable ? "" : undefined}
      aria-describedby={control.describedBy}
      aria-invalid={control.invalid}
      aria-disabled={unavailable || props["aria-disabled"] || undefined}
    />
  );
}
