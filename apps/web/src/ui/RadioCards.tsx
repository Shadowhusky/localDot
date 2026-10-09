import { clsx } from "clsx";
import { type ReactNode, useId } from "react";
import { Badge } from "./Badge.tsx";
import { useFieldControl } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { pressHandlers } from "./press.ts";

export interface RadioCardOption {
  value: string;
  label: string;
  description?: ReactNode;
  // A short tag after the label, such as "Recommended".
  tag?: string;
  // A small picture of the choice, such as a theme's colours, drawn inside the card.
  preview?: ReactNode;
  // A tile at the row's start, as in a grouped list.
  icon?: IconName;
  // A short value at a row's end, such as what the choice comes to.
  aside?: ReactNode;
  disabledReason?: string;
}

export interface RadioCardsProps {
  value: string;
  onValueChange(value: string): void;
  options: readonly RadioCardOption[];
  // Rows stack full width; tiles sit side by side and wrap.
  layout?: "rows" | "tiles";
  // Where a row's radio sits: before its text, or at its end after a leading tile.
  mark?: "start" | "end";
  // Rows that stand on their own on a page, further in and with larger titles.
  roomy?: boolean;
  name?: string;
  className?: string;
  "aria-label"?: string;
}

export function RadioCards({
  value,
  onValueChange,
  options,
  layout = "rows",
  mark = "start",
  roomy = false,
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
      data-mark={mark}
      data-roomy={roomy ? "" : undefined}
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
            {option.icon && (
              <span className="ui-tile ui-radio-card-tile" aria-hidden="true">
                <Icon name={option.icon} size={16} />
              </span>
            )}
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
            {option.aside !== undefined && (
              <span className="ui-radio-card-aside">{option.aside}</span>
            )}
            <span className="ui-radio-card-check" aria-hidden="true">
              <Icon name="check" size={12} strokeWidth={2.4} />
            </span>
          </label>
        );
      })}
    </div>
  );
}
