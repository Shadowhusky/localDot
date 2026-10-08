import { useEffect, useState } from "react";

export type Appearance = "graphite" | "midnight";
export const APPEARANCE_KEY = "localdot.appearance.v1";
export const APPEARANCE_EVENT = "localdot-appearance-change";
function stored(): Appearance {
  try {
    return localStorage.getItem(APPEARANCE_KEY) === "midnight" ? "midnight" : "graphite";
  } catch {
    return "graphite";
  }
}
export function useAppearance() {
  const [value, setValue] = useState<Appearance>(stored);
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    document.documentElement.dataset.appearance = value;
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
  }, [value]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === APPEARANCE_KEY || event.key === null) setValue(stored());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return {
    value,
    saved,
    change(next: Appearance) {
      if (next !== "graphite" && next !== "midnight") return;
      setValue(next);
      try {
        localStorage.setItem(APPEARANCE_KEY, next);
        setSaved(true);
      } catch {
        setSaved(false);
      }
    },
  };
}
