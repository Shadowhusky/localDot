import { useEffect, useState } from "react";
import type { ComputerPhase } from "../cells/hud-state.ts";

// The computer has no picture to show: the curtain covers the stage. A reconnecting or frozen
// computer keeps its last picture instead.
const UP = new Set<ComputerPhase>([
  "checking",
  "none",
  "starting",
  "restarting",
  "connecting",
  "stopping",
  "stopped",
  "failed",
  "unavailable",
]);
const WAKING = new Set<ComputerPhase>(["starting", "restarting", "connecting"]);
// dot's reaction to the computer coming on plays on the curtain before it lifts.
export const LIVE_HOLD_MS = 500;

export const curtainFor = (phase: ComputerPhase) => UP.has(phase);

// Whether the curtain is up, and the phase it shows: while it lifts it keeps its last words, and
// `lifting` says the computer has come up under it.
export function useCurtain(phase: ComputerPhase, hidden: boolean) {
  const up = !hidden && UP.has(phase);
  const [shown, setShown] = useState(phase);
  const [wasUp, setWasUp] = useState(up);
  const [lifting, setLifting] = useState(false);
  if (up && shown !== phase) setShown(phase);
  if (wasUp !== up) {
    setWasUp(up);
    setLifting(!up && !hidden && WAKING.has(shown));
  }
  useEffect(() => {
    if (!lifting) return;
    const timer = setTimeout(() => setLifting(false), LIVE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [lifting]);
  return { up: up || lifting, phase: up ? phase : shown, lifting };
}
