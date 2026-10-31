import { useCallback, useEffect, useRef, useState } from "react";

// A screen that has not come through by now is said to be late, and the stage offers the
// computer as it is.
export const SWITCH_SLOW_MS = 8000;

// Taking up another conversation, as the stage shows it. `pending`: the conversation is expected to
// show the picture already on the stage, which stays while that is confirmed. `covering`: the stage
// shows the loading state until the conversation's own screen is presented. `slow`: it never came,
// and the stage says so.
export type SwitchPhase = "pending" | "covering" | "slow";

export interface StageSwitch {
  // The conversation taken up; null for a new one.
  readonly to: string | null;
  readonly title?: string;
  readonly phase: SwitchPhase;
  readonly turn: number;
}

export interface SwitchSight {
  // The conversation taken up is the one on show, and which screen it shows is known.
  readonly settled: boolean;
  // The stage presents that screen: its own frames, and any frame drawn over them, are in.
  readonly presented: boolean;
  // The stage has nothing of the conversation's to wait for: the curtain is up, Replay holds it, or
  // it is out of sight.
  readonly yielded: boolean;
}

export function beginSwitch(
  now: StageSwitch | null,
  to: string | null,
  title: string | undefined,
  same: boolean,
  turn: number,
): StageSwitch {
  // A loading state already up stays up: what it covers may be half way to another screen.
  const covering = !same || (now !== null && now.phase !== "pending");
  return { to, title, phase: covering ? "covering" : "pending", turn };
}

// Returns `now` itself while nothing changes, so a render can tell.
export function stepSwitch(now: StageSwitch | null, sight: SwitchSight): StageSwitch | null {
  if (!now) return null;
  if (sight.yielded || (sight.settled && sight.presented)) return null;
  // Expected to keep the picture, and it changes: the loading state takes over at once.
  if (now.phase === "pending" && sight.settled) return { ...now, phase: "covering" };
  return now;
}

export function switchTimedOut(now: StageSwitch | null): StageSwitch | null {
  if (!now || now.phase === "slow") return now;
  return now.phase === "pending" ? null : { ...now, phase: "slow" };
}

// The stage's side of taking up a conversation: `begin` as the choice is made, `see` on every render
// with what the page knows, and `end` when the choice fails or the user dismisses a late screen.
export function useStageSwitch() {
  const [state, setState] = useState<StageSwitch | null>(null);
  const turns = useRef(0);
  const turn = state?.turn;
  const slow = state?.phase === "slow";
  useEffect(() => {
    if (turn === undefined || slow) return;
    const timer = setTimeout(
      () => setState((now) => (now?.turn === turn ? switchTimedOut(now) : now)),
      SWITCH_SLOW_MS,
    );
    return () => clearTimeout(timer);
  }, [turn, slow]);
  const begin = useCallback((to: string | null, title: string | undefined, same: boolean) => {
    const turn = ++turns.current;
    setState((now) => beginSwitch(now, to, title, same, turn));
  }, []);
  const end = useCallback(() => setState(null), []);
  const see = (sight: SwitchSight) => {
    const next = stepSwitch(state, sight);
    if (next !== state) setState(next);
    return next;
  };
  return { active: state !== null, begin, end, see };
}
