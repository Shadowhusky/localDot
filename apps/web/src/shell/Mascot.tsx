import { Dot } from "../dot/Dot.tsx";
import type { DotState } from "../dot/engine/states.ts";
import { Glyph } from "../dot/Glyph.tsx";

const BADGE = 24;

export interface MascotProps {
  // The status model's pose for dot. Given one, the mark is the live badge; without, the static
  // glyph.
  state?: DotState;
  // dot has control: the xenon rim.
  control?: boolean;
}

// dot's mark. As the HUD's live badge its ball fills the slot while the frame's transparent margin
// (an eighth of its size on each side) overflows it.
export function Mascot({ state, control = false }: MascotProps) {
  return (
    <span className="mascot" data-state={state}>
      {state ? (
        <Dot size={BADGE} state={state} control={control} style={{ margin: -BADGE / 8 }} />
      ) : (
        <Glyph />
      )}
    </span>
  );
}
