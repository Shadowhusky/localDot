import { useCallback, useState } from "react";
import {
  OVERVIEW_DENSITIES,
  OVERVIEW_FILTERS,
  type OverviewDensity,
  type OverviewFilter,
} from "./overview-model.ts";

export const OVERVIEW_KEY = "localdot.overview.v1";

export interface OverviewPreferences {
  density: OverviewDensity;
  filter: OverviewFilter;
}

// A phone shows a list of tiles, which it reads best; anything wider, a grid of medium ones.
const DEFAULTS: OverviewPreferences = { density: "m", filter: "all" };

export function readOverview(): OverviewPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(OVERVIEW_KEY) ?? "null");
    return {
      density: OVERVIEW_DENSITIES.includes(value?.density) ? value.density : DEFAULTS.density,
      filter: OVERVIEW_FILTERS.includes(value?.filter) ? value.filter : DEFAULTS.filter,
    };
  } catch {
    return DEFAULTS;
  }
}

// How dense the tiles are and which are shown belong to this browser.
export function useOverviewPreferences(): [
  OverviewPreferences,
  (patch: Partial<OverviewPreferences>) => void,
] {
  const [preferences, setPreferences] = useState(readOverview);
  const update = useCallback((patch: Partial<OverviewPreferences>) => {
    setPreferences((was) => {
      const next = { ...was, ...patch };
      try {
        localStorage.setItem(OVERVIEW_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  return [preferences, update];
}
