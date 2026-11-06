import { useCallback, useEffect, useRef, useState } from "react";
import { onForeground } from "./foreground.ts";

const FIRST_MS = 1000;
const MOST_MS = 32_000;

// What failed to load is tried again rather than left blank until a refresh: soon, then less often,
// and at once when the app comes back or the network does. After the last timed try only the app's
// return tries again. `attempt` is for the loading effect to depend on; `key` names what is loading,
// so another thing starts over.
export function useLoadAgain(key: string) {
  const [attempt, setAttempt] = useState(0);
  const round = useRef<{ timer?: ReturnType<typeof setTimeout>; wait: number; stop?: () => void }>({
    wait: FIRST_MS,
  });
  const clear = useCallback(() => {
    clearTimeout(round.current.timer);
    round.current.stop?.();
    round.current.stop = undefined;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the trigger.
  useEffect(() => {
    round.current.wait = FIRST_MS;
    return clear;
  }, [key, clear]);
  const failed = useCallback(() => {
    const now = round.current;
    clear();
    const again = () => {
      clear();
      setAttempt((value) => value + 1);
    };
    if (now.wait <= MOST_MS) now.timer = setTimeout(again, now.wait);
    now.wait *= 2;
    now.stop = onForeground(again);
  }, [clear]);
  return { attempt, failed };
}
