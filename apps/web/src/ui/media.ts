import { useSyncExternalStore } from "react";

export const PHONE = "(width < 700px)";
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
export const TOUCH = "(hover: none) and (pointer: coarse)";

export function matches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => matches(query),
  );
}
