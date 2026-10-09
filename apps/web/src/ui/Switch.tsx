import type { ReactNode } from "react";
import { type ChoiceProps, useChoice } from "./choice.tsx";

export interface SwitchProps extends ChoiceProps {
  // A 28 px tile before the label, as a GroupRow's: IconTile or Monogram.
  leading?: ReactNode;
}

// A setting that applies at once: the label on the left, the switch at the row's end.
export function Switch({ label, leading, ...props }: SwitchProps) {
  const { labelId, note, rowProps, inputProps } = useChoice(props);
  return (
    <label {...rowProps} data-control="switch">
      {leading}
      <span className="ui-choice-text">
        <span id={labelId} className="ui-choice-label">
          {label}
        </span>
        {note}
      </span>
      <span className="ui-switch">
        {/* biome-ignore lint/a11y/useAriaPropsForRole: a checkbox input reports its own checked state */}
        <input {...inputProps} role="switch" />
        <span className="ui-switch-knob" />
      </span>
    </label>
  );
}
