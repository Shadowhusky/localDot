import { useEffect, useRef } from "react";

// Escape on the page runs `run` while `enabled`, unless an overlay, a field typed in or a list box
// took it.
export function useEscape(enabled: boolean, run: () => void) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!enabled) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "dialog, [aria-modal='true'], input:not([type='checkbox'], [type='radio']), textarea, [role='listbox']",
        )
      )
        return;
      latest.current();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled]);
}
