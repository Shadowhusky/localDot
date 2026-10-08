import { useId } from "react";
import type { Appearance } from "./appearance.ts";
import "./onboarding.css";

export interface AppearanceControl {
  value: Appearance;
  saved: boolean;
  change(value: Appearance): void;
}
export function AppearancePicker({
  appearance,
  inSettings = false,
}: {
  appearance: AppearanceControl;
  inSettings?: boolean;
}) {
  const group = useId();
  return (
    <fieldset className="appearance-picker">
      <legend>Theme</legend>
      <div className="appearance-options">
        {(["graphite", "midnight"] as const).map((value) => (
          <label key={value} className="appearance-option">
            <input
              type="radio"
              name={group}
              value={value}
              checked={appearance.value === value}
              onChange={() => appearance.change(value)}
            />
            <span className={`appearance-tile ${value}`} aria-hidden="true" />
            <span>{value === "graphite" ? "Graphite" : "Midnight"}</span>
          </label>
        ))}
      </div>
      <p>
        {!appearance.saved
          ? "Applied for this visit. This browser could not save your preference."
          : inSettings
            ? "Applies to this browser."
            : "Applies to this browser. Change it in Settings."}
      </p>
    </fieldset>
  );
}
