import { RadioCards } from "../ui/RadioCards.tsx";
import { APPEARANCE_CHOICES, type AppearanceChoice, type DarkAppearance } from "./appearance.ts";
import "./onboarding.css";

export interface AppearanceControl {
  value: AppearanceChoice;
  dark: DarkAppearance;
  saved: boolean;
  change(value: AppearanceChoice): void;
}

export const APPEARANCE_NAMES: Record<AppearanceChoice, string> = {
  graphite: "Graphite",
  midnight: "Midnight",
  daylight: "Daylight",
  system: "System",
};

export function AppearancePicker({
  appearance,
  "aria-label": label,
}: {
  appearance: AppearanceControl;
  "aria-label"?: string;
}) {
  return (
    <RadioCards
      layout="tiles"
      aria-label={label}
      value={appearance.value}
      onValueChange={(value) => {
        const choice = APPEARANCE_CHOICES.find((option) => option === value);
        if (choice) appearance.change(choice);
      }}
      options={APPEARANCE_CHOICES.map((value) => ({
        value,
        label: APPEARANCE_NAMES[value],
        preview: (
          <span
            className="appearance-swatch"
            data-appearance={value}
            data-dark={value === "system" ? appearance.dark : undefined}
          />
        ),
      }))}
    />
  );
}
