import type { AvatarParams } from "./params.ts";

export interface ThemePack {
  id: string;
  renderer: { kind: string };
}

export const DEFAULT_PACK: ThemePack = { id: "dot", renderer: { kind: "procedural" } };

export type Presence = "glance" | "watch";

export interface AvatarRenderer {
  mount(el: HTMLElement, pack?: ThemePack): Promise<void>;
  apply(params: AvatarParams, dtMs: number): void;
  setPresence(presence: Presence): void;
  unmount(): void;
}
