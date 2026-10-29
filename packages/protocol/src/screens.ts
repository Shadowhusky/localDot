import { z as schema } from "zod";
import { ULID_PATTERN } from "./ids.ts";

export const SCREEN_NAMES = ["desktop", "browser"] as const;
export const ScreenName = schema.enum(SCREEN_NAMES);
export type ScreenName = schema.infer<typeof ScreenName>;

export const SwitchScreenInput = schema.strictObject({
  screen: ScreenName,
  // Start a stuck web browser again first, keeping its sign-ins.
  restart: schema.boolean().optional(),
});
export type SwitchScreenInput = schema.infer<typeof SwitchScreenInput>;

export const ScreenGeometry = schema.strictObject({
  w: schema.number().int().positive().max(8192),
  h: schema.number().int().positive().max(8192),
  scale: schema.union([schema.literal(1), schema.literal(2)]),
});
export type ScreenGeometry = schema.infer<typeof ScreenGeometry>;

export const ScreenSelectionSnapshot = schema
  .strictObject({
    screen: ScreenName,
    cellId: schema.string().regex(ULID_PATTERN),
    geometry: ScreenGeometry,
    revision: schema.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((value) => value.screen === "desktop" || value.revision > 0);
export type ScreenSelectionSnapshot = schema.infer<typeof ScreenSelectionSnapshot>;

export const ScreenSwitchData = schema.strictObject({
  screen: ScreenName,
  cellId: schema.string().regex(ULID_PATTERN),
  geometry: ScreenGeometry,
  by: schema.enum(["agent", "daemon"]),
  revision: schema.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ScreenSwitchData = schema.infer<typeof ScreenSwitchData>;
