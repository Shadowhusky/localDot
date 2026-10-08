import { type ChoiceProps, useChoice } from "./choice.tsx";

export interface CheckboxProps extends ChoiceProps {
  indeterminate?: boolean;
}

export function Checkbox({ label, indeterminate = false, ...props }: CheckboxProps) {
  const { labelId, note, rowProps, inputProps } = useChoice(props);
  return (
    <label {...rowProps} data-control="checkbox">
      <span className="ui-checkbox">
        <input
          {...inputProps}
          ref={(input) => {
            if (input) input.indeterminate = indeterminate;
          }}
          data-indeterminate={indeterminate ? "" : undefined}
        />
        <svg className="ui-checkbox-mark" viewBox="0 0 16 16" aria-hidden="true">
          <path className="ui-checkbox-check" d="M4 8.25 6.75 11 12 5.25" pathLength={1} />
          <path className="ui-checkbox-dash" d="M4.5 8h7" pathLength={1} />
        </svg>
      </span>
      <span className="ui-choice-text">
        <span id={labelId} className="ui-choice-label">
          {label}
        </span>
        {note}
      </span>
    </label>
  );
}
