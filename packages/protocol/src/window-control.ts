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
