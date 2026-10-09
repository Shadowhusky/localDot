import { RadioCards } from "../ui/RadioCards.tsx";
import type { Appearance } from "./appearance.ts";
import "./onboarding.css";

export interface AppearanceControl {
  value: Appearance;
  saved: boolean;
  change(value: Appearance): void;
}

const NAMES: Record<Appearance, string> = { graphite: "Graphite", midnight: "Midnight" };

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
      onValueChange={(value) => appearance.change(value === "midnight" ? "midnight" : "graphite")}
      options={(["graphite", "midnight"] as const).map((value) => ({
        value,
        label: NAMES[value],
        preview: <span className="appearance-swatch" data-appearance={value} />,
      }))}
    />
  );
}
