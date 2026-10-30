import { z } from "zod";

// Window-manager operations, never application buttons, close, or process termination.
export const WINDOW_ACTIONS = ["maximize_window", "restore_window", "minimize_window"] as const;
export const WindowControlRequest = z.object({
  action: z.enum(["inspect", ...WINDOW_ACTIONS]),
  windowId: z.number().int().positive().optional(),
});
export type WindowControlRequest = z.infer<typeof WindowControlRequest>;
export const WindowControlResult = z.object({ windowId: z.number().int().positive() });
export type WindowControlResult = z.infer<typeof WindowControlResult>;

// The windows on the screen, top first, each with its program's session and start (clock ticks
// since boot), and the computer's clock now; with `activate`, that window is brought forward first.
export const WindowsRequest = z.strictObject({ activate: z.number().int().positive().optional() });
export type WindowsRequest = z.infer<typeof WindowsRequest>;
const Box = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});
export const ScreenWindow = z.object({
  id: z.number().int().positive(),
  pid: z.number().int().nonnegative(),
  sid: z.number().int().positive().optional(),
  started: z.number().int().nonnegative().optional(),
  // The shell command, by its caller's id, whose process session shows the window.
  command: z.string().max(64).optional(),
  frame: Box,
  active: z.boolean(),
  transientFor: z.number().int().nonnegative().nullable().optional(),
});
export type ScreenWindow = z.infer<typeof ScreenWindow>;
export const WindowsResult = z.object({
  ticks: z.number().int().nonnegative(),
  windows: z.array(ScreenWindow).max(512),
});
export type WindowsResult = z.infer<typeof WindowsResult>;
