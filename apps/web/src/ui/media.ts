import { useSyncExternalStore } from "react";

export const PHONE = "(width < 700px)";
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
export const TOUCH = "(hover: none) and (pointer: coarse)";

// A query's list follows the page by itself, so each is made once: components read them on every
// render, and the page renders many times a second while dot works.
let made: typeof window.matchMedia | undefined;
const lists = new Map<string, MediaQueryList>();

function listOf(query: string): MediaQueryList | null {
  const match = window.matchMedia;
  if (typeof match !== "function") return null;
  if (match !== made) {
    made = match;
    lists.clear();
  }
  let list = lists.get(query);
  if (!list) {
    list = window.matchMedia(query);
    lists.set(query, list);
  }
  return list;
}

export function matches(query: string): boolean {
  return listOf(query)?.matches ?? false;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = listOf(query);
      if (!list) return () => {};
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => matches(query),
  );
}
