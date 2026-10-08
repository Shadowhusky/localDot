import { useId } from "react";
import type { Appearance } from "./appearance.ts";
import "./onboarding.css";

export interface AppearanceControl {
  value: Appearance;
  saved: boolean;
  change(value: Appearance): void;
}
export function AppearancePicker({ appearance }: { appearance: AppearanceControl }) {
  const group = useId();
  return (
    <fieldset className="appearance-picker">
      <legend>Theme</legend>
      <div className="appearance-options">
        {(["graphite", "midnight"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name={group}
              value={value}
              checked={appearance.value === value}
              onChange={() => appearance.change(value)}
            />
            <span className={`appearance-swatch ${value}`} aria-hidden="true" />
            <span>{value === "graphite" ? "Graphite" : "Midnight"}</span>
          </label>
        ))}
      </div>
      <p>
        {appearance.saved
          ? "Applies to this browser. Change it in Settings."
          : "Applied for this visit. This browser could not save your preference."}
      </p>
    </fieldset>
  );
}
