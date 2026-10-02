import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

// The agent's screens (spec "Signed-in browser (M7)"): the computer's desktop and the signed-in
// browser, each its own cell. The agent works on one at a time; switch_screen moves it.
export const SCREEN_NAMES = ["desktop", "browser"] as const;
export const ScreenName = z.enum(SCREEN_NAMES);
export type ScreenName = z.infer<typeof ScreenName>;

export const SwitchScreenInput = z.object({ screen: ScreenName });
export type SwitchScreenInput = z.infer<typeof SwitchScreenInput>;

// Both screens have the session's geometry (P8-R21); the event repeats it so a replay never has to
// assume it.
export const ScreenGeometry = z.object({
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  scale: z.union([z.literal(1), z.literal(2)]),
});
export type ScreenGeometry = z.infer<typeof ScreenGeometry>;

export const ScreenSwitchData = z.object({
  screen: ScreenName,
  cellId: z.string().regex(ULID_PATTERN),
  geometry: ScreenGeometry,
  // agent: switch_screen; daemon: the browser cell failed and the agent was moved back.
  by: z.enum(["agent", "daemon"]),
  note: z.string().max(200).optional(),
});
export type ScreenSwitchData = z.infer<typeof ScreenSwitchData>;
