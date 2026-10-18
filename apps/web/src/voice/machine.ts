// Push to talk (design: the composer's mic). Hold to talk and let go to put the words in the
// message; slide away and let go to cancel. A quick tap keeps listening until the next tap, so the
// mic also works for someone who can't hold a button, and through the browser's first permission
// prompt.
export type VoiceState =
  | { readonly phase: "idle" }
  // The mic and the speech engine are starting; a release here keeps listening.
  | {
      readonly phase: "starting";
      readonly held: boolean;
      readonly away: boolean;
      readonly at: number;
    }
  | {
      readonly phase: "listening";
      readonly held: boolean;
      readonly away: boolean;
      // When the press began, and when the engine started hearing.
      readonly at: number;
      readonly since: number;
    }
  // Let go: the last words are being turned into text.
  | { readonly phase: "finishing" };

export type VoiceEvent =
  | { readonly type: "press"; readonly at: number }
  | { readonly type: "release"; readonly at: number }
  | { readonly type: "away"; readonly away: boolean }
  | { readonly type: "started"; readonly at: number }
  // Enough: the longest recording was reached.
  | { readonly type: "stop" }
  // The words arrived, or the engine gave up.
  | { readonly type: "done" }
  | { readonly type: "cancel" };

// What the engine has to do for a step: start hearing, hand over its words, or stop and drop them.
export type VoiceEffect = "start" | "finish" | "abort";

export interface VoiceStep {
  readonly state: VoiceState;
  readonly effect?: VoiceEffect;
}

// A press shorter than this is a tap.
export const TAP_MS = 300;
export const MAX_LISTEN_MS = 120_000;
export const IDLE: VoiceState = { phase: "idle" };

export function voiceStep(state: VoiceState, event: VoiceEvent): VoiceStep {
  switch (event.type) {
    case "press":
      if (state.phase === "idle")
        return {
          state: { phase: "starting", held: true, away: false, at: event.at },
          effect: "start",
        };
      // A tap while it keeps listening ends it: before it started, there is nothing to keep.
      if (state.phase === "listening" && !state.held)
        return { state: { phase: "finishing" }, effect: "finish" };
      if (state.phase === "starting" && !state.held) return { state: IDLE, effect: "abort" };
      return { state };
    case "release":
      if ((state.phase !== "starting" && state.phase !== "listening") || !state.held)
        return { state };
      if (state.away) return { state: IDLE, effect: "abort" };
      if (state.phase === "starting" || event.at - state.at < TAP_MS)
        return { state: { ...state, held: false } };
      return { state: { phase: "finishing" }, effect: "finish" };
    case "away":
      if ((state.phase !== "starting" && state.phase !== "listening") || !state.held)
        return { state };
      return state.away === event.away ? { state } : { state: { ...state, away: event.away } };
    case "started":
      if (state.phase !== "starting") return { state };
      return {
        state: {
          phase: "listening",
          held: state.held,
          away: state.away,
          at: state.at,
          since: event.at,
        },
      };
    case "stop":
      return state.phase === "listening" || state.phase === "starting"
        ? { state: { phase: "finishing" }, effect: "finish" }
        : { state };
    case "done":
      return state.phase === "idle"
        ? { state }
        : { state: IDLE, ...(state.phase === "finishing" ? {} : { effect: "abort" as const }) };
    case "cancel":
      return state.phase === "idle" ? { state } : { state: IDLE, effect: "abort" };
  }
}

// Sliding this far off the mic arms the cancel; coming back within RETURN_PX disarms it, so a
// finger resting on the edge doesn't flicker between the two.
export const AWAY_PX = 40;
export const RETURN_PX = 24;

export function awayFrom(
  rect: { left: number; top: number; right: number; bottom: number },
  x: number,
  y: number,
  away: boolean,
): boolean {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy) > (away ? RETURN_PX : AWAY_PX);
}
