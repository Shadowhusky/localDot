import { clsx } from "clsx";
import { createContext, type MouseEvent, type ReactNode, useContext, useId } from "react";
import { Icon } from "./Icon.tsx";
import { joinIds } from "./merge.ts";

interface FieldState {
  controlId: string;
  labelId: string;
  describedBy: string | undefined;
  invalid: boolean;
  disabledReason: string | undefined;
}

const FieldContext = createContext<FieldState | undefined>(undefined);

const LABELABLE = "input, textarea, select";

function present(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== "";
}

export interface FieldProps {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  // Unavailable while set: the control keeps focus, and the reason takes the description's place.
  disabledReason?: string;
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  description,
  error,
  disabledReason,
  className,
  children,
}: FieldProps) {
  const id = useId();
  const controlId = `${id}control`;
  const labelId = `${id}label`;
  const ids = { description: `${id}description`, error: `${id}error`, reason: `${id}reason` };
  const described = present(description);
  const invalid = present(error) && !disabledReason;
  const shown = disabledReason ? "reason" : invalid ? "error" : "description";
  const state: FieldState = {
    controlId,
    labelId,
    describedBy: joinIds(
      disabledReason && ids.reason,
      invalid ? ids.error : undefined,
      described ? ids.description : undefined,
    ),
    invalid,
    disabledReason,
  };

  // A click on the label focuses the control and does no more: it never opens a picker.
  const focusControl = (event: MouseEvent<HTMLLabelElement>) => {
    const control = document.getElementById(controlId);
    if (!control || control.matches(LABELABLE)) return;
    event.preventDefault();
    const target = control.matches("button")
      ? control
      : control.querySelector<HTMLElement>("[aria-checked='true'], :checked, [tabindex='0']");
    target?.focus();
  };

  return (
    <div className={clsx("ui-field", className)} data-invalid={invalid ? "" : undefined}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a label's click is pointer-only; keys reach the control itself */}
      <label className="ui-field-label" id={labelId} htmlFor={controlId} onClick={focusControl}>
        {label}
      </label>
      <FieldContext.Provider value={state}>{children}</FieldContext.Provider>
      {(described || invalid || disabledReason) && (
        // Every message shares one cell, so swapping the description for an error moves nothing.
        <div className="ui-field-message">
          {described && (
            <p
              id={ids.description}
              className="ui-field-description"
              data-inactive={shown !== "description" ? "" : undefined}
            >
              {description}
            </p>
          )}
          {invalid && (
            <p id={ids.error} className="ui-field-error">
              <Icon name="circle-alert" size={12} />
              <span>{error}</span>
            </p>
          )}
          {disabledReason && (
            <p id={ids.reason} className="ui-field-description">
              {disabledReason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface ControlProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
}

// What a control inside a Field takes from it: its id, description, validity and availability.
export function useFieldControl({
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: ControlProps) {
  const field = useContext(FieldContext);
  return {
    id: id ?? field?.controlId,
    labelId: field?.labelId,
    describedBy: joinIds(describedBy, field?.describedBy),
    invalid: invalid ?? (field?.invalid ? true : undefined),
    disabledReason: field?.disabledReason,
  };
}

// A picker's popup renders inside its Field's tree; its own search field belongs to no Field.
export function OutsideField({ children }: { children: ReactNode }) {
  return <FieldContext.Provider value={undefined}>{children}</FieldContext.Provider>;
}
