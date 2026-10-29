import { useCallback, useLayoutEffect, useRef } from "react";

// A handler that keeps one identity across renders and runs the latest render's code, so handing it
// to a memoised child never draws the child again.
export function useHandler<A extends unknown[], R>(run: (...args: A) => R): (...args: A) => R {
  const latest = useRef(run);
  useLayoutEffect(() => {
    latest.current = run;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
