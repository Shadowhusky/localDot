import type { Point } from "@app/dot/engine/engine.ts";
import type { DotState } from "@app/dot/engine/states.ts";

// What the hero's app tells the 3D dot docked in it, read every frame.
export const heroDot: {
  state: DotState;
  control: boolean;
  // The work's point on the Theatre, as fractions of its width and height.
  focus: Point | null;
  // Changes when dot starts a new line, so it bobs as it says it.
  line: string;
} = {
  state: "idle",
  control: false,
  focus: null,
  line: "",
};
