import { useEffect, useState } from "react";
import { onForeground } from "../lib/foreground.ts";

// True once `on` has held for `ms`, false the moment it stops: a state that flips straight back
// shows nothing. With `fromReturn`, time the app spent in the background does not count: the wait
// starts again when the app comes back, so a connection it is still restoring shows nothing.
export function useHeldFor(on: boolean, ms: number, fromReturn = false): boolean {
  const [held, setHeld] = useState(false);
  const [returned, setReturned] = useState(0);
  useEffect(() => {
    if (!fromReturn) return;
    return onForeground((reason) => {
      if (reason === "focus") return false;
      setHeld(false);
      setReturned((n) => n + 1);
    });
  }, [fromReturn]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a return restarts the wait
  useEffect(() => {
    if (!on) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms, returned]);
  return on && held;
}
