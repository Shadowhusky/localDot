import { useLayoutEffect, useSyncExternalStore } from "react";
import type { RoutineTarget } from "./RoutineSheet.tsx";
import type { RoutinesView } from "./useRoutines.ts";

export interface RoutinesControl {
  readonly view: RoutinesView;
  open(target: RoutineTarget, trigger?: HTMLElement): void;
}

// The app's routines and the one sheet that shows them, for cards deep in the thread, without
// threading them through every layer between.
let current: RoutinesControl | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useProvideRoutines(control: RoutinesControl): void {
  useLayoutEffect(() => {
    current = control;
    notify();
    return () => {
      if (current !== control) return;
      current = null;
      notify();
    };
  }, [control]);
}

export function useRoutinesControl(): RoutinesControl | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
