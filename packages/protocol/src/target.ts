import { z } from "zod";
import { Point, Rect } from "./geometry.ts";
import { boundedText } from "./text.ts";

export const TargetSource = z.enum(["ax", "dom", "som", "ocr", "vision", "coords"]);

export const Target = z.object({
  point: Point,
  bbox: Rect.optional(),
  source: TargetSource,
  role: boundedText(64).optional(),
  name: boundedText(64).optional(),
  app: boundedText(128).optional(),
  window: boundedText(256).optional(),
  url: boundedText(2048).optional(),
  mark: z.number().int().nonnegative().optional(),
  secret: z.boolean().optional(),
  // Set by trusted desktop Chromium perception only after validating the password's form.
  loginOrigin: z.string().url().optional(),
  editable: z.boolean().optional(),
  // A check box's, radio button's or switch's tick as it was read.
  checked: z.enum(["true", "false", "mixed"]).optional(),
});
export type Target = z.infer<typeof Target>;
