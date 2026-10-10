import { useCallback, useEffect, useRef, useState } from "react";

export type RailView = "chat" | "activity" | "routines";
export interface PanelPreferences {
  chat: boolean;
  activity: boolean;
  view: RailView;
}
export const PANELS_KEY = "localdot.panels.v1";
const DEFAULTS: PanelPreferences = { chat: true, activity: true, view: "chat" };

export function readPanels(): PanelPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "null");
    return {
      chat: typeof value?.chat === "boolean" ? value.chat : true,
      activity: typeof value?.activity === "boolean" ? value.activity : true,
      view: ["chat", "activity", "routines"].includes(value?.view) ? value.view : "chat",
    };
  } catch {
    return DEFAULTS;
  }
}

// Layout belongs to this browser, not to a task. A narrow viewport adapts without rewriting it.
export function usePanelPreferences() {
  const [panels, setPanels] = useState(readPanels);
  const current = useRef(panels);
  current.current = panels;
  const update = useCallback((patch: Partial<PanelPreferences>) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    try {
      localStorage.setItem(PANELS_KEY, JSON.stringify(next));
    } catch {}
    setPanels(next);
  }, []);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === PANELS_KEY || event.key === null) setPanels(readPanels());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return { panels, update };
}
