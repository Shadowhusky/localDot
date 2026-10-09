import { clsx } from "clsx";
import { type ReactNode, useId } from "react";
import { Badge } from "./Badge.tsx";
import { useFieldControl } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { pressHandlers } from "./press.ts";

export interface RadioCardOption {
  value: string;
  label: string;
  description?: ReactNode;
  // A short tag after the label, such as "Recommended".
  tag?: string;
  // A small picture of the choice, such as a theme's colours, drawn inside the card.
  preview?: ReactNode;
  disabledReason?: string;
}

export interface RadioCardsProps {
  value: string;
  onValueChange(value: string): void;
  options: readonly RadioCardOption[];
  // Rows stack full width; tiles sit side by side and wrap.
  layout?: "rows" | "tiles";
  name?: string;
  className?: string;
  "aria-label"?: string;
}

export function RadioCards({
  value,
  onValueChange,
  options,
  layout = "rows",
  name,
  className,
  "aria-label": label,
}: RadioCardsProps) {
  const id = useId();
  const control = useFieldControl({});
  return (
    <div
      role="radiogroup"
      id={control.id}
      className={clsx("ui-radio-cards", className)}
      data-layout={layout}
      aria-label={label}
      aria-labelledby={label ? undefined : control.labelId}
      aria-describedby={control.describedBy}
    >
      {options.map((option, index) => {
        const note = option.disabledReason ?? option.description;
        const labelId = `${id}${index}label`;
        const noteId = `${id}${index}note`;
        return (
          <label
            key={option.value}
            {...pressHandlers}
            className="ui-radio-card"
            data-unavailable={option.disabledReason ? "" : undefined}
          >
            <input
              type="radio"
              name={name ?? id}
              value={option.value}
              checked={option.value === value}
              className="ui-choice-input"
              aria-disabled={option.disabledReason ? true : undefined}
              aria-labelledby={labelId}
              aria-describedby={note ? noteId : undefined}
              onClick={(event) => {
                if (option.disabledReason) event.preventDefault();
              }}
              onChange={() => {
                if (!option.disabledReason) onValueChange(option.value);
              }}
            />
            <span className="ui-radio-mark" aria-hidden="true" />
            {option.preview !== undefined && (
              <span className="ui-radio-card-preview" aria-hidden="true">
                {option.preview}
              </span>
            )}
            <span className="ui-choice-text">
              <span className="ui-radio-card-title">
                <span id={labelId} className="ui-choice-label">
                  {option.label}
                </span>
                {option.tag && <Badge>{option.tag}</Badge>}
              </span>
              {note && (
                <span id={noteId} className="ui-choice-note">
                  {note}
                </span>
              )}
            </span>
            <span className="ui-radio-card-check" aria-hidden="true">
              <Icon name="check" size={12} strokeWidth={2.4} />
            </span>
          </label>
        );
      })}
    </div>
  );
}
