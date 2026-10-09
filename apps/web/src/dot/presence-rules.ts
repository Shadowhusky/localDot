// Where the one live dot is (design-v2 §10.17): the hero on the curtain, the dock beside the stage,
// the badge in the island where the band has no room for it, or above first-run setup.
export type PresencePlace = "hero" | "dock" | "badge" | "intro";

export interface PresenceInput {
  // Settings → Appearance → Show dot.
  showDot: boolean;
  // The curtain covers the stage: nothing is known yet, or the computer is off, starting or failed.
  curtain: boolean;
  // Replay is open: dot sits in its own band, or beside the chosen recording, whatever Watch shows.
  replaying: boolean;
  // Replay's list fills the screen without the chosen recording beside it: dot has no place there.
  browsing?: boolean;
  // A phone's keyboard is up and the band has collapsed.
  keyboard: boolean;
  // First-run setup covers the app.
  setup?: boolean;
  // The stage fills the screen, with no band under it.
  full?: boolean;
}

export function presencePlace({
  showDot,
  curtain,
  replaying,
  browsing = false,
  keyboard,
  setup,
  full,
}: PresenceInput): PresencePlace | null {
  if (!showDot) return null;
  if (setup) return "intro";
  if (replaying) return browsing ? null : "dock";
  if (curtain) return "hero";
  return keyboard || full ? "badge" : "dock";
}
