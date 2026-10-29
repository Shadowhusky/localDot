import { clock } from "../copy/format.ts";
import { type TaskTimer, timerSeconds } from "../session/status.ts";
import { useSessionNow } from "../session/useNowMs.ts";

export interface TaskTimeProps {
  timer?: TaskTimer | null;
  elapsedS: number | null;
  countdownS?: number | null;
}

// The HUD's time, which counts by itself so the page need not draw again each second: the seconds
// to a retry, or how long the task, or its wait, has run. Without a timer, or the page's clock,
// it shows the seconds it was given.
export function TaskTime({ timer, elapsedS, countdownS = null }: TaskTimeProps) {
  const now = useSessionNow(!!timer, timer ? ("to" in timer ? timer.to : timer.from) : 0);
  const shown =
    timer && now !== null
      ? timerSeconds(timer, now)
      : countdownS !== null
        ? { left: countdownS }
        : elapsedS !== null
          ? { counted: elapsedS }
          : null;
  if (!shown) return null;
  return "left" in shown ? `in ${shown.left} s` : clock(shown.counted);
}
