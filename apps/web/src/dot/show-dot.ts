import { useEffect, useState } from "react";

export const SHOW_DOT_KEY = "localdot.show-dot.v1";

function stored(): boolean {
  try {
    return localStorage.getItem(SHOW_DOT_KEY) !== "off";
  } catch {
    return true;
  }
}

// Settings → Appearance → Show dot: on unless this browser was told otherwise.
export function useShowDot() {
  const [value, setValue] = useState(stored);
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === SHOW_DOT_KEY || event.key === null) setValue(stored());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return {
    value,
    saved,
    change(next: boolean) {
      setValue(next);
      try {
        localStorage.setItem(SHOW_DOT_KEY, next ? "on" : "off");
        setSaved(true);
      } catch {
        setSaved(false);
      }
    },
  };
}

export type ShowDotControl = ReturnType<typeof useShowDot>;
