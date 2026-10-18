import { clsx } from "clsx";
import {
  type ComponentProps,
  type CSSProperties,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { useFieldControl } from "./Field.tsx";
import { observeTextAreaSize, resizeTextArea } from "./textarea-size.ts";

const sizesItself = () =>
  typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content") === true;

export interface TextAreaProps extends Omit<ComponentProps<"textarea">, "rows" | "disabled"> {
  // It grows with its text from one line up to this many, then scrolls.
  maxRows?: number;
  // No box of its own, for a field whose container draws one, such as a composer card.
  bare?: boolean;
}

export function TextArea({
  maxRows = 8,
  bare = false,
  className,
  readOnly,
  style,
  ref,
  ...props
}: TextAreaProps) {
  const control = useFieldControl(props);
  const unavailable = Boolean(control.disabledReason);
  const own = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => {
    if (!own.current) throw new Error("Textarea is not mounted");
    return own.current;
  }, []);

  useLayoutEffect(() => {
    const area = own.current;
    if (!area || sizesItself()) return;
    return observeTextAreaSize(area);
  }, []);
  // Controlled values and visual props can change without a native input event.
  useLayoutEffect(() => {
    if (own.current) resizeTextArea(own.current);
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
      data-bare={bare ? "" : undefined}
      data-invalid={control.invalid ? "" : undefined}
      data-unavailable={unavailable ? "" : undefined}
      aria-describedby={control.describedBy}
      aria-invalid={control.invalid}
      aria-disabled={unavailable || props["aria-disabled"] || undefined}
    />
  );
}
