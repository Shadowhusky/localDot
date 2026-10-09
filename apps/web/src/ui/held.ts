import { useEffect, useState } from "react";

// True once `on` has held for `ms`, false the moment it stops: a state that flips straight back
// shows nothing.
export function useHeldFor(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on && held;
}
