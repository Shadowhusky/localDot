import { clsx } from "clsx";
import {
  type ChangeEvent,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  useId,
} from "react";
import { joinIds } from "./merge.ts";
import { pressHandlers } from "./press.ts";

export interface ChoiceProps
  extends Omit<ComponentProps<"input">, "type" | "children" | "disabled" | "onChange" | "ref"> {
  label: ReactNode;
  description?: ReactNode;
  // Unavailable while set: the control keeps focus, ignores presses, and shows this in place of
  // the description.
  disabledReason?: string;
  onCheckedChange?(checked: boolean, event: ChangeEvent<HTMLInputElement>): void;
}

// A checkbox or switch on a row with its label and note; the whole row takes the press.
export function useChoice({
  description,
  disabledReason,
  onCheckedChange,
  className,
  ...props
}: Omit<ChoiceProps, "label">) {
  const id = useId();
  const labelId = `${id}label`;
  const noteId = `${id}note`;
  const note = disabledReason ?? description;
  const noted = note !== undefined && note !== null && note !== "";
  return {
    labelId,
    note: noted && (
      <span id={noteId} className="ui-choice-note">
        {note}
      </span>
    ),
    rowProps: {
      ...pressHandlers,
      className: clsx("ui-choice", className),
      "data-unavailable": disabledReason ? "" : undefined,
    },
    inputProps: {
      ...props,
      type: "checkbox",
      className: "ui-choice-input",
      "aria-disabled": disabledReason ? true : undefined,
      // Named by the label alone; the note under it is the description.
      "aria-labelledby": props["aria-labelledby"] ?? labelId,
      "aria-describedby": joinIds(props["aria-describedby"], noted ? noteId : undefined),
      onClick(event: MouseEvent<HTMLInputElement>) {
        if (disabledReason) event.preventDefault();
        else props.onClick?.(event);
      },
      // React reports the change even when the click that made it was cancelled.
      onChange(event: ChangeEvent<HTMLInputElement>) {
        if (!disabledReason) onCheckedChange?.(event.target.checked, event);
      },
    },
  };
}
