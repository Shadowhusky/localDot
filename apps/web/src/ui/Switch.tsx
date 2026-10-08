import { type ChoiceProps, useChoice } from "./choice.tsx";

export type SwitchProps = ChoiceProps;

// A setting that applies at once: the label on the left, the switch at the row's end.
export function Switch({ label, ...props }: SwitchProps) {
  const { labelId, note, rowProps, inputProps } = useChoice(props);
  return (
    <label {...rowProps} data-control="switch">
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
