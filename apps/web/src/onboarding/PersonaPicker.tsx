import { PERSONAS, type PersonaId, PersonaId as PersonaIds } from "@localdot/protocol";
import { Dot } from "../dot/Dot.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import "./onboarding.css";

// Each dot in its outfit, with what it is good at. Choosing one sets the next task's dot. Tiles fill a
// page; rows, each dot small at its start, fit a popover.
export function PersonaPicker({
  value,
  onChange,
  layout = "tiles",
  disabledReason,
  "aria-label": label = "Your dot",
}: {
  value: PersonaId;
  onChange(value: PersonaId): void;
  layout?: "tiles" | "rows";
  disabledReason?: string;
  "aria-label"?: string;
}) {
  return (
    <RadioCards
      layout={layout}
      mark={layout === "rows" ? "end" : "start"}
      className="persona-picker"
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const parsed = PersonaIds.safeParse(next);
        if (parsed.success) onChange(parsed.data);
      }}
      options={Object.values(PERSONAS).map((persona, index) => ({
        value: persona.id,
        label: persona.name,
        description: persona.blurb,
        ...(disabledReason ? { disabledReason } : {}),
        preview: (
          <span className="persona-preview" data-layout={layout}>
            <Dot
              size={layout === "rows" ? 40 : 64}
              wearables={persona.wearables}
              seed={index + 1}
            />
          </span>
        ),
      }))}
    />
  );
}
