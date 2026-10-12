import { type ClipboardEvent, useRef } from "react";
import { enterCode, eraseCode } from "./code.ts";
import { useFieldControl } from "./Field.tsx";

export interface CodeFieldProps {
  label: string;
  length: number;
  value: string;
  unavailable?: boolean;
  onChange(value: string): void;
  onBlur?(): void;
}

// A one-time code, one cell per character: typing moves on, a pasted or messaged code fills them
// all, and Backspace steps back. The first cell offers the text message's code on a phone.
export function CodeField({
  label,
  length,
  value,
  unavailable = false,
  onChange,
  onBlur,
}: CodeFieldProps) {
  const cells = useRef<(HTMLInputElement | null)[]>([]);
  const control = useFieldControl({});
  const chars = [...value];
  const go = (index: number) => {
    const cell = cells.current[index];
    if (!cell) return;
    cell.focus();
    cell.select();
  };
  const enter = (index: number, input: string) => {
    const next = enterCode(value, index, input, length);
    onChange(next.code);
    requestAnimationFrame(() => go(next.focus));
  };
  return (
    <fieldset className="ui-code" aria-label={label}>
      {Array.from({ length }, (_, index) => (
        <input
          // biome-ignore lint/suspicious/noArrayIndexKey: a cell is its position
          key={index}
          ref={(cell) => {
            cells.current[index] = cell;
          }}
          id={index === 0 ? control.id : undefined}
          className="ui-code-cell"
          value={chars[index] ?? ""}
          inputMode="text"
          autoCapitalize="none"
          spellCheck={false}
          autoComplete={index === 0 ? "one-time-code" : "off"}
          enterKeyHint={index === length - 1 ? "done" : "next"}
          aria-label={`${label}, ${index + 1} of ${length}`}
          aria-describedby={control.describedBy}
          aria-invalid={control.invalid}
          readOnly={unavailable}
          aria-disabled={unavailable || undefined}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={onBlur}
          onChange={(event) => {
            const now = event.currentTarget.value;
            const had = chars[index] ?? "";
            if (!now) {
              onChange(eraseCode(value, index).code);
              return;
            }
            enter(index, had && now.length > had.length ? now.replace(had, "") : now);
          }}
          onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
            event.preventDefault();
            if (!unavailable) enter(index, event.clipboardData.getData("text/plain"));
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && !event.currentTarget.value && !unavailable) {
              event.preventDefault();
              const next = eraseCode(value, index);
              onChange(next.code);
              go(next.focus);
            } else if (event.key === "ArrowLeft" && index > 0) {
              event.preventDefault();
              go(index - 1);
            } else if (event.key === "ArrowRight" && index < Math.min(chars.length, length - 1)) {
              event.preventDefault();
              go(index + 1);
            }
          }}
        />
      ))}
    </fieldset>
  );
}
