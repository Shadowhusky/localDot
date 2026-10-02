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
});
export type Target = z.infer<typeof Target>;
