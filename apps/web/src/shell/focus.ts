import { useEffect, useState } from "react";
import { useMediaQuery } from "../ui/media.ts";
import { LANDSCAPE_PHONE } from "./layout.ts";

// Without a touch for this long, the status pill fades from the picture.
export const STILL_MS = 3000;

export interface FocusInput {
  // A phone held sideways.
  landscape: boolean;
  // The live computer is on the stage: no curtain over it, and not Replay.
  live: boolean;
  // Something only the conversation can show needs the user: dot's question, or the controls dot
  // handed over.
  needsThread: boolean;
  // The user left focus mode since the phone was last turned sideways.
  left: boolean;
  // The user asked for full screen, which a phone held upright shows as focus mode too.
  full?: boolean;
}

// Phone landscape focus mode (design-v2 §8.5): turned sideways while the computer is live, or asked
// for full screen, a phone gives the whole screen to the picture.
export function inFocus({ landscape, live, needsThread, left, full = false }: FocusInput): boolean {
  return (landscape || full) && live && !needsThread && !left;
}

export function useFocusMode(live: boolean, needsThread: boolean, full = false) {
  const landscape = useMediaQuery(LANDSCAPE_PHONE);
  const [left, setLeft] = useState(false);
  // Turning the phone upright forgets the choice, so the next turn sideways focuses again.
  if (left && !landscape) setLeft(false);
  return {
    landscape,
    focus: inFocus({ landscape, live, needsThread, left, full }),
    leave: () => setLeft(true),
  };
}

// True once nothing has touched the screen for `ms` while `active`; any touch wakes it again.
export function useStill(active: boolean, ms = STILL_MS): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    if (!active) return;
    let timer = setTimeout(() => setStill(true), ms);
    const touched = () => {
      clearTimeout(timer);
      setStill(false);
      timer = setTimeout(() => setStill(true), ms);
    };
    document.addEventListener("pointerdown", touched, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", touched, true);
      setStill(false);
    };
  }, [active, ms]);
  return active && still;
}
