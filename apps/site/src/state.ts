import type { Accessory } from "@localdot/protocol";
import { useSyncExternalStore } from "react";

export type Permission = "ask" | "auto" | "full";

// What the visitor has chosen in the story, shared by the app in the hero, the 3D layer and the
// story's controls.
export const site: {
  control: "dot" | "you";
  permission: Permission;
  accessory: Accessory | undefined;
  // The story has taken the app out of sight; its recording can rest.
  offstage: boolean;
  // How far back the story has rewound the recording, from where it was (1) to its start (0).
  rewind: number | null;
  // The film is playing over the page, which can rest behind it.
  film: boolean;
  // The story is at Step in: dot's game is on its screen, for the visitor to take over.
  game: boolean;
  version: number;
} = {
  control: "dot",
  permission: "auto",
  accessory: undefined,
  offstage: false,
  rewind: null,
  film: false,
  game: false,
  version: 0,
};

const listeners = new Set<() => void>();

export function setSite(patch: Partial<Omit<typeof site, "version">>): void {
  Object.assign(site, patch);
  site.version++;
  for (const listener of listeners) listener();
}

export function onSite(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSite(): typeof site {
  useSyncExternalStore(onSite, () => site.version);
  return site;
}
