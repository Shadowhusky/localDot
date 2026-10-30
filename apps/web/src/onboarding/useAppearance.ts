import { useSyncExternalStore } from "react";
import { chooseAppearance, currentAppearance, subscribeAppearance } from "./appearance.ts";

export function useAppearance() {
  const { choice, dark, saved } = useSyncExternalStore(subscribeAppearance, currentAppearance);
  return { value: choice, dark, saved, change: chooseAppearance };
}
