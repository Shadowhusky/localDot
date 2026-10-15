import { Accessory, outfit, type PersonaId } from "@localdot/protocol";
import { Dot } from "../dot/Dot.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";

const NONE = "none";

const NAMES: Record<Accessory, string> = {
  cap: "Cap",
  sunglasses: "Shades",
  bow: "Bow",
  "star-pin": "Star",
};

// What this localDot's dot wears to tell it apart from the user's others, shown on the dot they
// chose, so they see the pair as it will look.
export function AccessoryPicker({
  persona,
  value,
  onChange,
}: {
  persona: PersonaId;
  value: Accessory | undefined;
  onChange(value: Accessory | undefined): void;
}) {
  const options = [undefined, ...Accessory.options] as const;
  return (
    <RadioCards
      layout="tiles"
      compact
      className="accessory-picker"
      aria-label="Accessory"
      value={value ?? NONE}
      onValueChange={(next) => {
        const parsed = Accessory.safeParse(next);
        onChange(parsed.success ? parsed.data : undefined);
      }}
      options={options.map((accessory, index) => ({
        value: accessory ?? NONE,
        label: accessory ? NAMES[accessory] : "None",
        preview: (
          <span className="accessory-preview">
            <Dot size={48} wearables={outfit(persona, accessory)} seed={index + 11} />
          </span>
        ),
      }))}
    />
  );
}
