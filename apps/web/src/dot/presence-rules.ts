// Where the one live dot is (design-v2 §10.17): the hero on the curtain, the dock beside the stage,
// or the badge in the island where the band has no room for it.
export type PresencePlace = "hero" | "dock" | "badge";

export interface PresenceInput {
  // Settings → Appearance → Show dot.
  showDot: boolean;
  // The curtain covers the stage: the computer is off, starting or failed.
  curtain: boolean;
  // Nothing is known yet, so the curtain has no copy and no dot.
  checking: boolean;
  // The stage isn't on screen, as in Replay.
  stageHidden: boolean;
  // A phone's keyboard is up and the band has collapsed.
  keyboard: boolean;
}

export function presencePlace({
  showDot,
  curtain,
  checking,
  stageHidden,
  keyboard,
}: PresenceInput): PresencePlace | null {
  if (!showDot || stageHidden || checking) return null;
  if (curtain) return "hero";
  return keyboard ? "badge" : "dock";
}
