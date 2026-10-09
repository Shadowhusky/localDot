// Where the one live dot is (design-v2 §10.17): the hero on the curtain, the dock beside the stage,
// the badge in the island where the band has no room for it, or above first-run setup.
export type PresencePlace = "hero" | "dock" | "badge" | "intro";

export interface PresenceInput {
  // Settings → Appearance → Show dot.
  showDot: boolean;
  // The curtain covers the stage: nothing is known yet, or the computer is off, starting or failed.
  curtain: boolean;
  // The stage isn't on screen, as in Replay.
  stageHidden: boolean;
  // A phone's keyboard is up and the band has collapsed.
  keyboard: boolean;
  // First-run setup covers the app.
  setup?: boolean;
}

export function presencePlace({
  showDot,
  curtain,
  stageHidden,
  keyboard,
  setup,
}: PresenceInput): PresencePlace | null {
  if (!showDot) return null;
  if (setup) return "intro";
  if (stageHidden) return null;
  if (curtain) return "hero";
  return keyboard ? "badge" : "dock";
}
